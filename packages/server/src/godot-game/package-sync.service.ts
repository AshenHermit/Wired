import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PackageRevisionSyncState, PackageSyncStatus } from '@wired-io/shared';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { Repository } from 'typeorm';
import { RoomRuntimeService } from './room-runtime.service';
import { RuntimeObserver } from './room-runtime.types';

/** How often pending/failed applications are retried. */
const RETRY_TICK_MS = 5_000;
/** The first retry waits 10s, the second 20s. */
const RETRY_STEP_MS = 10_000;
const MAX_ATTEMPTS = 3;
/** A runtime that never answers a dispatch is treated as failed. */
const DISPATCH_TIMEOUT_MS = 30_000;

type RuntimeState = 'pending' | 'applied' | 'failed';
type ClientState = 'pending' | 'ready' | 'failed';

interface ClientSyncRecord {
  state: ClientState;
  revision: number;
  error: string | null;
  updatedAt: string;
}

interface SyncRecord {
  roomId: string;
  packageId: number;
  revision: number;
  publishedAt: string;
  runtimeState: RuntimeState;
  runtimeError: string | null;
  runtimeUpdatedAt: string | null;
  dispatchedAt: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  clients: Map<number, ClientSyncRecord>;
}

/**
 * Dispatches published package revisions to the room runtime and tracks how
 * far each target has applied them.
 *
 * This is deliberately not a delivery guarantee. The published manifest is the
 * source of truth: records are in-memory hints that are rebuilt by reconciling
 * manifests when a runtime starts, a peer joins, or a retry tick fires. A
 * backend restart therefore loses only timing information, not correctness.
 *
 * Only the package's own `room` receives the revision. Packages without a room
 * and parent/child packages are not broadcast implicitly; each package that is
 * bound to a room is synchronized independently.
 */
@Injectable()
export class PackageSyncService
  implements RuntimeObserver, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PackageSyncService.name);
  private readonly records = new Map<string, SyncRecord>();
  private readonly peers = new Map<string, Set<number>>();
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packages: Repository<ScriptingPackage>,
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisions: Repository<ScriptingPackageRevision>,
    private readonly runtime: RoomRuntimeService,
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
    if (!pkg.room) {
      this.logger.log(
        `Package ${packageId} is not bound to a room; revision ${revision} stays published only`,
      );
      return;
    }

    const roomId = String(pkg.room.id);
    const key = this.recordKey(roomId, packageId);
    const existing = this.records.get(key);
    if (existing && existing.revision === revision) {
      // Idempotent: a repeated publish or a duplicate event must not resend.
      return;
    }

    const row = await this.revisions.findOne({
      where: { package: { id: packageId }, revision },
    });
    const publishedAt = (row?.publishedAt ?? new Date()).toISOString();
    const record: SyncRecord = {
      roomId,
      packageId,
      revision,
      publishedAt,
      runtimeState: 'pending',
      runtimeError: null,
      runtimeUpdatedAt: null,
      dispatchedAt: null,
      attempts: 0,
      nextAttemptAt: null,
      clients: new Map(),
    };
    this.records.set(key, record);
    this.dispatch(record);
  }

  /** Latest published revision per package of the room plus target states. */
  async getStatuses(roomId: string): Promise<PackageSyncStatus[]> {
    const roomNumber = Number(roomId);
    if (!Number.isInteger(roomNumber)) {
      return [];
    }
    const packages = await this.packages.find({
      where: { room: { id: roomNumber } },
    });
    const statuses: PackageSyncStatus[] = [];
    for (const pkg of packages) {
      const latest = await this.revisions.findOne({
        where: { package: { id: pkg.id }, status: 'published' },
        order: { revision: 'DESC' },
      });
      if (!latest?.publishedAt) {
        continue;
      }
      statuses.push(
        this.toStatus(
          pkg,
          String(roomNumber),
          latest.revision,
          latest.publishedAt,
        ),
      );
    }
    return statuses.sort((a, b) => a.packageId - b.packageId);
  }

  /**
   * Ensures every published package of the room has a record for its latest
   * revision and retries applications that never reached the runtime.
   */
  async reconcileRoom(roomId: string, freshRuntime = false): Promise<void> {
    const roomNumber = Number(roomId);
    if (!Number.isInteger(roomNumber)) {
      return;
    }
    const packages = await this.packages.find({
      where: { room: { id: roomNumber } },
    });
    for (const pkg of packages) {
      const latest = await this.revisions.findOne({
        where: { package: { id: pkg.id }, status: 'published' },
        order: { revision: 'DESC' },
      });
      if (!latest?.publishedAt) {
        continue;
      }
      const key = this.recordKey(roomId, pkg.id);
      const existing = this.records.get(key);
      if (!existing || existing.revision !== latest.revision) {
        const record: SyncRecord = {
          roomId,
          packageId: pkg.id,
          revision: latest.revision,
          publishedAt: latest.publishedAt.toISOString(),
          runtimeState: 'pending',
          runtimeError: null,
          runtimeUpdatedAt: null,
          dispatchedAt: null,
          attempts: 0,
          nextAttemptAt: null,
          clients: new Map(),
        };
        this.records.set(key, record);
        this.dispatch(record);
        continue;
      }
      if (freshRuntime) {
        // A new runtime process has no applied revisions and no clients: the
        // previous session's confirmations are no longer true.
        existing.attempts = 0;
        existing.nextAttemptAt = null;
        existing.runtimeState = 'pending';
        existing.runtimeError = null;
        existing.runtimeUpdatedAt = null;
        existing.dispatchedAt = null;
        existing.clients.clear();
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

  // --- RuntimeObserver ----------------------------------------------------

  onRuntimeReady(roomId: string): void {
    void this.reconcileRoom(roomId, true).catch((error: unknown) => {
      this.logger.error(
        `Failed to reconcile packages for room ${roomId}: ${this.errorMessage(error)}`,
      );
    });
  }

  onPeerAuthenticated(roomId: string, peer: number): void {
    this.peerSet(roomId).add(peer);
    for (const record of this.records.values()) {
      if (record.roomId !== roomId || record.runtimeState !== 'applied') {
        continue;
      }
      if (!record.clients.has(peer)) {
        record.clients.set(peer, {
          state: 'pending',
          revision: record.revision,
          error: null,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    // The joining client must receive the current revision even if the publish
    // notification was lost; the manifest remains the source of truth.
    void this.reconcileRoom(roomId).catch((error: unknown) => {
      this.logger.error(
        `Failed to reconcile packages after a join in room ${roomId}: ${this.errorMessage(error)}`,
      );
    });
  }

  onPeerLeft(roomId: string, peer: number): void {
    this.peers.get(roomId)?.delete(peer);
    for (const record of this.records.values()) {
      if (record.roomId === roomId) {
        record.clients.delete(peer);
      }
    }
  }

  onPackagesApplied(
    roomId: string,
    packageId: number,
    revision: number,
    files: number,
  ): void {
    const record = this.records.get(this.recordKey(roomId, packageId));
    if (!record || record.revision > revision) {
      this.logger.warn(
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
    for (const peer of this.peerSet(roomId)) {
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
    const record = this.records.get(this.recordKey(roomId, packageId));
    if (!record || record.revision !== revision) {
      return;
    }
    record.runtimeState = 'failed';
    record.runtimeError = error;
    record.runtimeUpdatedAt = new Date().toISOString();
    record.nextAttemptAt =
      record.attempts < MAX_ATTEMPTS
        ? Date.now() + RETRY_STEP_MS * record.attempts
        : null;
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

  private updateClient(
    roomId: string,
    peer: number,
    packageId: number,
    revision: number,
    state: ClientState,
    error: string | null,
  ): void {
    const record = this.records.get(this.recordKey(roomId, packageId));
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
    const now = Date.now();
    for (const record of this.records.values()) {
      if (
        record.runtimeState === 'pending' &&
        record.dispatchedAt !== null &&
        now - Date.parse(record.dispatchedAt) >= DISPATCH_TIMEOUT_MS
      ) {
        record.runtimeState = 'failed';
        record.runtimeError = 'runtime did not confirm the revision in time';
        record.runtimeUpdatedAt = new Date(now).toISOString();
        record.nextAttemptAt = now;
        this.logger.warn(
          `Runtime did not confirm package ${record.packageId} revision ${record.revision} in room ${record.roomId}`,
        );
      }
      if (record.nextAttemptAt === null || record.nextAttemptAt > now) {
        continue;
      }
      if (record.attempts >= MAX_ATTEMPTS) {
        record.nextAttemptAt = null;
        continue;
      }
      this.dispatch(record);
    }
  }

  private toStatus(
    pkg: ScriptingPackage,
    roomId: string,
    revision: number,
    publishedAt: Date,
  ): PackageSyncStatus {
    const record = this.records.get(this.recordKey(roomId, pkg.id));
    const base = {
      packageId: pkg.id,
      name: pkg.name,
      publishedAt: publishedAt.toISOString(),
    };

    if (!record || record.revision !== revision) {
      return {
        ...base,
        revision,
        state: record ? 'stale' : 'published',
        runtime: {
          state: 'pending',
          revision,
          error: null,
          updatedAt: null,
        },
        clients: [],
      };
    }

    const peers = this.peerSet(roomId);
    const clients = [...record.clients.entries()]
      .sort(([a], [b]) => a - b)
      .map(([peer, client]) => ({ peer, ...client }));
    return {
      ...base,
      revision: record.revision,
      state: this.aggregateState(record, peers),
      runtime: {
        state: record.runtimeState,
        revision: record.revision,
        error: record.runtimeError,
        updatedAt: record.runtimeUpdatedAt,
      },
      clients,
    };
  }

  private aggregateState(
    record: SyncRecord,
    peers: Set<number>,
  ): PackageRevisionSyncState {
    if (record.runtimeState === 'failed') {
      return 'failed';
    }
    if (
      [...record.clients.entries()].some(
        ([peer, client]) => peers.has(peer) && client.state === 'failed',
      )
    ) {
      return 'failed';
    }
    if (record.runtimeState !== 'applied') {
      return record.dispatchedAt ? 'pending' : 'published';
    }
    if (peers.size > 0) {
      const ready = [...peers].every(
        (peer) => record.clients.get(peer)?.state === 'ready',
      );
      return ready ? 'ready' : 'applied';
    }
    return 'applied';
  }

  private recordKey(roomId: string, packageId: number): string {
    return `${roomId}:${packageId}`;
  }

  private peerSet(roomId: string): Set<number> {
    let peers = this.peers.get(roomId);
    if (!peers) {
      peers = new Set<number>();
      this.peers.set(roomId, peers);
    }
    return peers;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
