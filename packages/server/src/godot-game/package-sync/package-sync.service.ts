import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PackageSyncStatus } from '@wired-io/shared';
import { errorMessage } from 'src/common/errors';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import {
  DependentRoomPackage,
  PackageDeliveryService,
} from 'src/scripting-packages/delivery/package-delivery.service';
import { In, Repository } from 'typeorm';
import { DispatchScheduler, RETRY_TICK_MS } from './dispatch-scheduler';
import { RoomRuntimeService } from '../runtime/room-runtime.service';
import { RuntimeObserver } from '../runtime/room-runtime.types';
import { StatusReporter } from './status-reporter';
import { ClientState, SyncRecord, SyncRecordStore } from './sync-record-store';

/**
 * Dispatches published package revisions to the room runtime and tracks how
 * far each target has applied them.
 *
 * This is deliberately not a delivery guarantee. The published manifest is the
 * source of truth: records are in-memory hints that are rebuilt by reconciling
 * manifests when a runtime starts, a peer joins, or a retry tick fires. A
 * backend restart therefore loses only timing information, not correctness.
 *
 * The package's own `room` (when it has one) receives the revision. Packages
 * without a room are libraries: they are never dispatched themselves, but every
 * room package that (transitively) references them is re-dispatched, because
 * its runtime artifact embeds the library bytes by value.
 *
 * Responsibilities are split: `SyncRecordStore` owns the records and peers,
 * `DispatchScheduler` owns the retry policy, `StatusReporter` owns the public
 * aggregation; this service only orchestrates them over the runtime facade.
 */
@Injectable()
export class PackageSyncService
  implements RuntimeObserver, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PackageSyncService.name);
  private readonly store = new SyncRecordStore();
  private readonly scheduler = new DispatchScheduler();
  private readonly reporter = new StatusReporter(this.store);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packages: Repository<ScriptingPackage>,
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisions: Repository<ScriptingPackageRevision>,
    private readonly runtime: RoomRuntimeService,
    private readonly delivery: PackageDeliveryService,
  ) {}

  onModuleInit(): void {
    this.runtime.setObserver(this);
    this.timer = setInterval(() => this.retryDue(), RETRY_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.runtime.setObserver(undefined);
  }

  /**
   * Called after the backend fixed a published revision. The revision is the
   * notification payload; file bytes are never sent over this channel.
   *
   * A room package is dispatched to its own runtime, then its dependents are
   * refreshed. A global package has no runtime of its own, so only its
   * dependents are refreshed.
   */
  async revisionPublished(packageId: number, revision: number): Promise<void> {
    const pkg = await this.packages.findOne({
      where: { id: packageId },
      relations: { room: true },
    });
    if (!pkg) {
      this.logger.warn(
        `Cannot dispatch revision ${revision}: package ${packageId} not found`,
      );
      return;
    }

    if (pkg.enabled === false) {
      this.logger.log(
        `Package ${packageId} is disabled; revision ${revision} stays published only`,
      );
      return;
    }

    if (pkg.room) {
      this.dispatchOwnRevision(packageId, String(pkg.room.id), revision);
    } else {
      this.logger.log(
        `Package ${packageId} is not bound to a room; revision ${revision} stays published only`,
      );
    }

    await this.dispatchDependents(packageId);
  }

  /**
   * Re-dispatches packages whose published bytes changed without a new
   * revision (a slug rename rewrites them in place). Each package is refreshed
   * at its own latest published revision; an unchanged revision must still be
   * resent, so `dispatchOwnRevision` — which skips equal revisions — is not
   * used here.
   */
  async packagesChanged(packageIds: number[]): Promise<void> {
    const ids = [...new Set(packageIds)].sort((a, b) => a - b);
    if (ids.length === 0) {
      return;
    }
    const rows = await this.packages.find({
      where: { id: In(ids) },
      relations: { room: true },
    });
    const latest = await this.latestPublishedRevisions(ids);
    for (const pkg of rows) {
      const revision = latest.get(pkg.id);
      if (revision === undefined || !pkg.room || pkg.enabled === false) {
        continue;
      }
      this.refreshDependent({
        packageId: pkg.id,
        roomId: pkg.room.id,
        revision: revision.revision,
      });
    }
  }

  /** Latest published revision per package of the room plus target states. */
  async getStatuses(roomId: string): Promise<PackageSyncStatus[]> {
    const packages = await this.roomPackages(roomId, false);
    const latest = await this.latestPublishedRevisions(
      packages.map((pkg) => pkg.id),
    );
    const statuses: PackageSyncStatus[] = [];
    for (const pkg of packages) {
      const revision = latest.get(pkg.id);
      statuses.push({
        ...this.reporter.toStatus(
          pkg,
          roomId,
          revision?.revision ?? null,
          revision?.publishedAt ?? null,
        ),
        sizeBytes: revision
          ? revision.files.reduce((sum, file) => sum + file.size, 0)
          : null,
      });
    }
    return statuses.sort((a, b) => a.packageId - b.packageId);
  }

  /**
   * Ensures every published package of the room has a record for its latest
   * revision and retries applications that never reached the runtime.
   */
  async reconcileRoom(roomId: string, freshRuntime = false): Promise<void> {
    const packages = await this.roomPackages(roomId);
    const latest = await this.latestPublishedRevisions(
      packages.map((pkg) => pkg.id),
    );
    for (const pkg of packages) {
      const revision = latest.get(pkg.id);
      if (!revision?.publishedAt) {
        continue;
      }
      const existing = this.store.get(roomId, pkg.id);
      if (!existing || existing.revision !== revision.revision) {
        this.dispatch(this.store.create(roomId, pkg.id, revision.revision));
        continue;
      }
      if (freshRuntime) {
        // A new runtime process has no applied revisions and no clients: the
        // previous session's confirmations are no longer true.
        this.store.resetForDispatch(existing);
      }
      if (
        freshRuntime ||
        !existing.dispatchedAt ||
        (existing.runtimeState === 'failed' && existing.nextAttemptAt === null)
      ) {
        this.dispatch(existing, freshRuntime);
      }
    }
  }

  // --- lifecycle ----------------------------------------------------------

  /**
   * Applies a PATCH of the `enabled` flag: a disabled package is unloaded from
   * the runtime and forgotten, an enabled one is reconciled back in.
   */
  async packageEnabledChanged(packageId: number): Promise<void> {
    const pkg = await this.packages.findOne({
      where: { id: packageId },
      relations: { room: true },
    });
    if (!pkg) {
      this.logger.warn(`Cannot toggle enabled: package ${packageId} not found`);
      return;
    }
    if (!pkg.room) {
      return;
    }
    const roomId = String(pkg.room.id);
    if (pkg.enabled === false) {
      this.store.remove(roomId, packageId);
      this.runtime.sendPackageUnload(roomId, packageId, false);
      this.logger.log(`Package ${packageId} disabled in room ${roomId}`);
      return;
    }
    await this.reconcileRoom(roomId);
    this.logger.log(`Package ${packageId} enabled in room ${roomId}`);
  }

  /** Applies a DELETE: the package and its files leave the room runtime. */
  packageRemoved(packageId: number, roomId: number): void {
    const id = String(roomId);
    this.store.remove(id, packageId);
    this.runtime.sendPackageUnload(id, packageId, true);
    this.logger.log(`Package ${packageId} removed from room ${id}`);
  }

  // --- RuntimeObserver ----------------------------------------------------

  onRuntimeReady(roomId: string): void {
    // A ready line also means a *new* process: the previous session's peers
    // died with it and never sent `player_left`. Keeping them would make
    // `aggregateState` wait for clients that no longer exist, so the package
    // status would stick at `applied` forever.
    this.store.forgetPeers(roomId);
    void this.reconcileRoom(roomId, true).catch((error: unknown) => {
      this.logger.error(
        `Failed to reconcile packages for room ${roomId}: ${errorMessage(error)}`,
      );
    });
    void this.announceRoomPackages(roomId).catch((error: unknown) => {
      this.logger.error(
        `Failed to announce room packages for room ${roomId}: ${errorMessage(error)}`,
      );
    });
  }

  onPeerAuthenticated(roomId: string, peer: number): void {
    this.store.peers(roomId).add(peer);
    for (const record of this.store.forRoom(roomId)) {
      if (record.runtimeState !== 'applied' || record.clients.has(peer)) {
        continue;
      }
      record.clients.set(peer, {
        state: 'pending',
        revision: record.revision,
        error: null,
        updatedAt: new Date().toISOString(),
      });
    }
    // The joining client must receive the current revision even if the publish
    // notification was lost; the manifest remains the source of truth.
    void this.reconcileRoom(roomId).catch((error: unknown) => {
      this.logger.error(
        `Failed to reconcile packages after a join in room ${roomId}: ${errorMessage(error)}`,
      );
    });
  }

  onPeerLeft(roomId: string, peer: number): void {
    this.store.removePeer(roomId, peer);
    for (const record of this.store.forRoom(roomId)) {
      record.clients.delete(peer);
    }
  }

  onPackagesApplied(
    roomId: string,
    packageId: number,
    revision: number,
    files: number,
  ): void {
    const record = this.store.get(roomId, packageId);
    if (!record) {
      // Dependencies report their own applies, and the backend does not track
      // a record for a library without a runtime. Staying quiet (debug) keeps
      // the log free of misleading "obsolete package" warnings.
      this.logger.debug(
        `Ignoring confirmation for untracked package ${packageId} revision ${revision} in room ${roomId}`,
      );
      return;
    }
    if (record.revision > revision) {
      this.logger.debug(
        `Ignoring confirmation for obsolete package ${packageId} revision ${revision} in room ${roomId}`,
      );
      return;
    }
    if (record.revision < revision) {
      // A newer publish happened between dispatch and confirmation: the
      // runtime applied the latest manifest, which is the source of truth.
      record.revision = revision;
      record.clients.clear();
    }
    record.runtimeState = 'applied';
    record.runtimeError = null;
    record.runtimeUpdatedAt = new Date().toISOString();
    record.nextAttemptAt = null;
    for (const peer of this.store.peers(roomId)) {
      if (!record.clients.has(peer)) {
        record.clients.set(peer, {
          state: 'pending',
          revision,
          error: null,
          updatedAt: record.runtimeUpdatedAt,
        });
      }
    }
    this.logger.log(
      `Runtime applied package ${packageId} revision ${revision} (${files} files) in room ${roomId}`,
    );
  }

  onPackagesFailed(
    roomId: string,
    packageId: number,
    revision: number,
    error: string,
  ): void {
    const record = this.store.get(roomId, packageId);
    if (!record || record.revision !== revision) {
      return;
    }
    record.runtimeState = 'failed';
    record.runtimeError = error;
    record.runtimeUpdatedAt = new Date().toISOString();
    this.scheduler.scheduleRetry(record);
    this.logger.warn(
      `Runtime failed to apply package ${packageId} revision ${revision} in room ${roomId}: ${error}`,
    );
  }

  onClientPackagesReady(
    roomId: string,
    peer: number,
    packageId: number,
    revision: number,
  ): void {
    this.updateClient(roomId, peer, packageId, revision, 'ready', null);
  }

  onClientPackagesFailed(
    roomId: string,
    peer: number,
    packageId: number,
    revision: number,
    error: string,
  ): void {
    this.updateClient(roomId, peer, packageId, revision, 'failed', error);
  }

  // --- internals ----------------------------------------------------------

  /**
   * Packages bound to the room, the only ones with a runtime to dispatch to.
   * `enabledOnly` is false for the panel listing, which also shows disabled
   * packages so they can be downloaded or re-enabled.
   */
  private roomPackages(
    roomId: string,
    enabledOnly = true,
  ): Promise<ScriptingPackage[]> {
    return this.packages.find({
      where: {
        room: { id: Number(roomId) },
        ...(enabledOnly ? { enabled: true } : {}),
      },
    });
  }

  /**
   * Sends the authoritative package id list of the room to a fresh runtime,
   * so it can drop save records of packages deleted while it was stopped.
   */
  private async announceRoomPackages(roomId: string): Promise<void> {
    const ids = await this.delivery.collectRuntimePackageIds(Number(roomId));
    this.runtime.sendRoomPackages(roomId, ids);
  }

  /**
   * One query for every room package instead of one `findOne` per package:
   * the room status is polled every 100 ms while a client waits for packages,
   * so a per-package lookup multiplies the load by the package count.
   */
  private async latestPublishedRevisions(
    packageIds: number[],
  ): Promise<Map<number, ScriptingPackageRevision>> {
    if (packageIds.length === 0) {
      return new Map();
    }
    const rows = await this.revisions.find({
      where: { package: { id: In(packageIds) }, status: 'published' },
      relations: { package: true },
      order: { revision: 'DESC' },
    });
    const latest = new Map<number, ScriptingPackageRevision>();
    for (const row of rows) {
      const packageId = row.package?.id;
      if (packageId === undefined || latest.has(packageId)) {
        continue;
      }
      latest.set(packageId, row);
    }
    return latest;
  }

  /**
   * Dispatches a package's own revision to its room runtime. A repeated
   * same-revision publish is idempotent for the package itself: only the
   * dependents of a library need refreshing in that case.
   */
  private dispatchOwnRevision(
    packageId: number,
    roomId: string,
    revision: number,
  ): void {
    const existing = this.store.get(roomId, packageId);
    if (existing && existing.revision === revision) {
      return;
    }

    this.dispatch(this.store.create(roomId, packageId, revision));
  }

  /**
   * Re-dispatches every room package that references the published package.
   * Dependents are not published themselves, so their runtimes only pick up the
   * new library bytes when the artifact is requested again. The scan is best
   * effort: a failure must not undo the publication.
   */
  private async dispatchDependents(packageId: number): Promise<void> {
    let dependents: DependentRoomPackage[];
    try {
      dependents = await this.delivery.findDependentRoomPackages(packageId);
    } catch (error) {
      this.logger.error(
        `Failed to scan dependents of package ${packageId}: ${errorMessage(error)}`,
      );
      return;
    }

    for (const dependent of dependents) {
      this.refreshDependent(dependent);
    }
  }

  /**
   * Brings one dependent's record to the given revision and dispatches it. An
   * unchanged revision is still resent: the dependent's own revision did not
   * change, but the library bytes it embeds did. Not recursive on purpose, so a
   * chain of dependents is refreshed exactly once.
   */
  private refreshDependent(dependent: DependentRoomPackage): void {
    const roomId = String(dependent.roomId);
    const existing = this.store.get(roomId, dependent.packageId);
    if (!existing) {
      this.dispatch(
        this.store.create(roomId, dependent.packageId, dependent.revision),
      );
      return;
    }

    if (dependent.revision > existing.revision) {
      // The scan is not authoritative: a lagging result must not downgrade a
      // revision the runtime already adopted through `onPackagesApplied`.
      existing.revision = dependent.revision;
    }
    // Clearing clients on a same-revision refresh is deliberate: the revision
    // alone no longer identifies the artifact, so a late confirmation from the
    // previous artifact may be accepted as if it were the new one.
    this.store.resetForDispatch(existing);
    this.dispatch(existing);
  }

  private updateClient(
    roomId: string,
    peer: number,
    packageId: number,
    revision: number,
    state: ClientState,
    error: string | null,
  ): void {
    const record = this.store.get(roomId, packageId);
    if (!record || record.revision !== revision) {
      return;
    }
    record.clients.set(peer, {
      state,
      revision,
      error,
      updatedAt: new Date().toISOString(),
    });
    if (state === 'failed') {
      this.logger.warn(
        `Client peer=${peer} failed to apply package ${packageId} revision ${revision} in room ${roomId}: ${error ?? 'unknown error'}`,
      );
    }
  }

  private dispatch(record: SyncRecord, force = false): boolean {
    const runtime = this.runtime.getRuntime(record.roomId);
    if (runtime?.state !== 'running') {
      return false;
    }
    if (!force && record.runtimeState === 'applied') {
      return false;
    }
    const sent = this.runtime.sendPackage(
      record.roomId,
      record.packageId,
      record.revision,
    );
    if (!sent) {
      return false;
    }
    record.dispatchedAt = new Date().toISOString();
    record.runtimeState = 'pending';
    record.runtimeError = null;
    record.runtimeUpdatedAt = null;
    record.attempts += 1;
    record.nextAttemptAt = null;
    this.logger.log(
      `Requested package ${record.packageId} revision ${record.revision} from room ${record.roomId} runtime (attempt ${record.attempts})`,
    );
    return true;
  }

  private retryDue(): void {
    this.scheduler.runDue(this.store.all(), (record) => this.dispatch(record));
  }
}
