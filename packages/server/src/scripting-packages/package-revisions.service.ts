import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  CreatePackageRevisionPayload,
  PackageFileEntry,
  PackageManifest,
  PackageRevision,
} from '@wired-io/shared';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import {
  SavedDraftFile,
  PackageStorageService,
} from './package-storage.service';
import { validatePackageRevisionFiles } from './package-manifest';
import {
  collectPackageReferences,
  decodePackageText,
  isTextPackageFile,
} from './package-runtime-references';
import { ScriptingPackagesService } from './scripting-packages.service';
import {
  PACKAGE_REVISION_DISPATCHER,
  PackageRevisionDispatcher,
} from 'src/godot-game/package-sync.types';
import { InjectDataSource } from '@nestjs/typeorm';

/**
 * Draft and published revisions of a scripting package.
 *
 * Only file bytes live in the storage directory; the declared manifest lives
 * in Postgres. A revision becomes visible to players (`published`) only after
 * every declared file was verified on disk by {@link PackageStorageService}.
 */
@Injectable()
export class PackageRevisionsService {
  private readonly logger = new Logger(PackageRevisionsService.name);
  /**
   * Packages whose bytes are being verified and moved by *this* process. The
   * authoritative guard is the Postgres advisory lock below: this set is only
   * the cheap in-process fast path (and the whole guard when no DataSource is
   * available, e.g. in unit tests).
   */
  private readonly publishing = new Set<number>();

  constructor(
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisionsRepository: Repository<ScriptingPackageRevision>,
    private readonly packagesService: ScriptingPackagesService,
    private readonly storage: PackageStorageService,
    @Optional()
    @Inject(PACKAGE_REVISION_DISPATCHER)
    private readonly dispatcher?: PackageRevisionDispatcher,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  /**
   * Starts a new draft revision. Any unfinished draft of the same package is
   * discarded: only one draft exists per package at a time, so abandoned
   * uploads cannot accumulate or leak into a later publication.
   */
  async createDraft(
    packageId: number,
    payload: CreatePackageRevisionPayload,
  ): Promise<PackageRevision> {
    await this.assertNotPublishing(packageId);

    const pkg = await this.packagesService.findOne(packageId);
    const files = validatePackageRevisionFiles(payload?.files);

    await this.discardDrafts(packageId);

    const maxRevision = await this.revisionsRepository.maximum('revision', {
      package: { id: packageId },
    });
    const revision = (maxRevision ?? 0) + 1;

    try {
      const saved = await this.revisionsRepository.save(
        this.revisionsRepository.create({
          package: pkg,
          revision,
          status: 'draft',
          files,
        }),
      );
      return toRevision(saved, packageId);
    } catch (error) {
      // Two concurrent drafts compute the same revision number; the unique
      // index rejects one of them. Report a retryable conflict, not a 500.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Package ${packageId} received a concurrent draft, try again`,
        );
      }
      throw error;
    }
  }

  async uploadFile(
    packageId: number,
    revision: number,
    filepath: string,
    data: Buffer,
  ): Promise<SavedDraftFile> {
    await this.assertNotPublishing(packageId);

    const row = await this.findRevision(packageId, revision);

    if (row.status === 'published') {
      throw new ConflictException(
        `Revision ${revision} is already published and cannot be modified`,
      );
    }

    if (row.status !== 'draft') {
      throw new ConflictException(
        `Revision ${revision} was replaced by a newer draft and cannot be modified`,
      );
    }

    if (!row.files.some((entry) => entry.filepath === filepath)) {
      throw new BadRequestException(
        `File ${filepath} is not declared in revision ${revision}`,
      );
    }

    return this.storage.saveDraftFile(packageId, revision, filepath, data);
  }

  /**
   * Verifies the uploaded files against the declared manifest and makes the
   * revision visible to players. Repeating the call for an already published
   * revision is safe: it returns the published revision without touching disk.
   */
  async publish(packageId: number, revision: number): Promise<PackageRevision> {
    const row = await this.findRevision(packageId, revision);

    if (row.status === 'published') {
      return toRevision(row, packageId);
    }

    if (row.status !== 'draft') {
      throw new ConflictException(
        `Revision ${revision} was replaced by a newer draft and cannot be published`,
      );
    }

    // Reject uploads for this package while its bytes are verified and moved.
    const lock = await this.acquirePublishLock(packageId);
    this.publishing.add(packageId);
    try {
      await this.storage.publishRevision(
        packageId,
        revision,
        row.files,
        async () => {
          row.status = 'published';
          row.publishedAt = new Date();
          await this.revisionsRepository.save(row);
        },
      );
    } finally {
      this.publishing.delete(packageId);
      await this.releasePublishLock(lock, packageId);
    }

    await this.recordPinnedDependencies(packageId, revision, row.files);
    await this.dispatchPublished(packageId, revision);
    return toRevision(row, packageId);
  }

  /** Advisory lock key; `hashtext` maps it to the lock's bigint id. */
  private publishLockKey(packageId: number): string {
    return `wired.package-publish:${packageId}`;
  }

  /**
   * Namespace-scoped Postgres advisory locks let every instance agree on which
   * package is being published without a new column (`DB_SYNC` would mutate
   * the shared schema) and without a second source of truth.
   */
  private async assertNotPublishing(packageId: number): Promise<void> {
    const publishing =
      this.publishing.has(packageId) ||
      (await this.isPublishLockedElsewhere(packageId));
    if (publishing) {
      throw new ConflictException(
        `Package ${packageId} is being published, try again in a moment`,
      );
    }
  }

  /**
   * Probes the advisory lock by taking and immediately releasing it: the lock
   * is held exactly while another instance verifies and moves the bytes.
   * A database error must not block uploads, so it counts as "not publishing".
   */
  private async isPublishLockedElsewhere(
    packageId: number,
  ): Promise<boolean> {
    if (!this.dataSource) {
      return false;
    }
    let runner: QueryRunner;
    try {
      runner = this.dataSource.createQueryRunner();
      await runner.connect();
    } catch (error) {
      this.warnLockFailure(packageId, error);
      return false;
    }
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [this.publishLockKey(packageId)],
      )) as Array<{ locked?: boolean }>;
      const acquired = rows[0]?.locked === true;
      if (acquired) {
        await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [
          this.publishLockKey(packageId),
        ]);
      }
      return !acquired;
    } catch (error) {
      this.warnLockFailure(packageId, error);
      return false;
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  /**
   * Takes the cross-instance publication lock. Returns `null` when the lock
   * was taken locally only (no DataSource, or the database is unreachable):
   * publication keeps working, but only the in-process guard is active.
   * Throws when another instance holds the lock.
   */
  private async acquirePublishLock(
    packageId: number,
  ): Promise<QueryRunner | null> {
    if (!this.dataSource) {
      return null;
    }
    let runner: QueryRunner;
    try {
      runner = this.dataSource.createQueryRunner();
      await runner.connect();
    } catch (error) {
      this.warnLockFailure(packageId, error);
      return null;
    }
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [this.publishLockKey(packageId)],
      )) as Array<{ locked?: boolean }>;
      if (rows[0]?.locked !== true) {
        await runner.release().catch(() => undefined);
        throw new ConflictException(
          `Package ${packageId} is being published, try again in a moment`,
        );
      }
      return runner;
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }
      await runner.release().catch(() => undefined);
      this.warnLockFailure(packageId, error);
      return null;
    }
  }

  private async releasePublishLock(
    runner: QueryRunner | null,
    packageId: number,
  ): Promise<void> {
    if (!runner) {
      return;
    }
    try {
      await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [
        this.publishLockKey(packageId),
      ]);
    } catch (error) {
      this.warnLockFailure(packageId, error);
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private warnLockFailure(packageId: number, error: unknown): void {
    this.logger.warn(
      `Package ${packageId} publication lock is only process-local: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  /**
   * Records the dependency revisions this revision references right now.
   *
   * A published revision is immutable, so the closure built from it must be
   * immutable too. Resolving dependencies against "latest published" at build
   * time made the same `(packageId, revision)` produce a different artifact
   * key whenever a library published. Pinning at publish time keeps the key
   * stable and still lets a client re-dispatch on a new library revision (the
   * dependents of the library are refreshed explicitly).
   *
   * The bytes are already committed at this point, so a failure here must not
   * turn a successful publication into an error: the resolver falls back to
   * "latest published" for a revision without pins.
   */
  private async recordPinnedDependencies(
    packageId: number,
    revision: number,
    files: PackageFileEntry[],
  ): Promise<void> {
    try {
      const referenced = new Set<number>();
      for (const entry of files) {
        if (!isTextPackageFile(entry.filepath)) {
          continue;
        }
        const data = await this.storage.readPublishedFile(
          packageId,
          revision,
          entry.filepath,
        );
        let text: string;
        try {
          text = decodePackageText(entry.filepath, data);
        } catch {
          // An undecodable file is reported by the artifact build instead.
          continue;
        }
        for (const ref of collectPackageReferences(text)) {
          if (ref.packageId !== packageId) {
            referenced.add(ref.packageId);
          }
        }
      }

      const pins = new Map<number, number>();
      for (const dependencyId of [...referenced].sort((a, b) => a - b)) {
        const dependency = await this.revisionsRepository.findOne({
          where: { package: { id: dependencyId }, status: 'published' },
          order: { revision: 'DESC' },
        });
        if (dependency) {
          pins.set(dependencyId, dependency.revision);
        }
      }
      await this.storage.writePinnedDependencies(packageId, revision, pins);
    } catch (error) {
      this.logger.warn(
        `Package ${packageId} revision ${revision} was published but its dependency pins were not recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Publication is already fixed at this point; a notification failure must
   * not turn a successful Emit into an error. The runtime reconciles the
   * manifest on start/reconnect, so a lost signal is recoverable.
   */
  private async dispatchPublished(
    packageId: number,
    revision: number,
  ): Promise<void> {
    if (!this.dispatcher) {
      return;
    }
    try {
      await this.dispatcher.revisionPublished(packageId, revision);
    } catch (error) {
      this.logger.error(
        `Package ${packageId} revision ${revision} was published but runtime dispatch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Published revisions are public. Drafts stay visible only to callers that
   * ask for them explicitly (the editor), never to anonymous readers.
   */
  async list(
    packageId: number,
    options: { includeDrafts?: boolean } = {},
  ): Promise<PackageRevision[]> {
    await this.packagesService.findOne(packageId);

    const rows = await this.revisionsRepository.find({
      where: options.includeDrafts
        ? { package: { id: packageId } }
        : { package: { id: packageId }, status: 'published' },
      order: { revision: 'DESC' },
    });
    return rows.map((row) => toRevision(row, packageId));
  }

  /**
   * The latest published revision. Clients download exactly these files and
   * delete anything else inside the managed package directory.
   */
  async getManifest(packageId: number): Promise<PackageManifest> {
    const pkg = await this.packagesService.findOne(packageId);

    const row = await this.revisionsRepository.findOne({
      where: { package: { id: packageId }, status: 'published' },
      order: { revision: 'DESC' },
    });

    if (!row || !row.publishedAt) {
      throw new NotFoundException(
        `Package ${packageId} has no published revision`,
      );
    }

    return toManifest(row, packageId, pkg.name);
  }

  async getManifestForRevision(
    packageId: number,
    revision: number,
  ): Promise<PackageManifest> {
    const pkg = await this.packagesService.findOne(packageId);
    const row = await this.findRevision(packageId, revision);

    if (row.status !== 'published' || !row.publishedAt) {
      throw new NotFoundException(
        `Revision ${revision} of package ${packageId} is not published`,
      );
    }

    return toManifest(row, packageId, pkg.name);
  }

  async readPublishedFile(
    packageId: number,
    revision: number,
    filepath: string,
  ): Promise<Buffer> {
    await assertPublishedFile(
      this.revisionsRepository,
      packageId,
      revision,
      filepath,
    );
    return this.storage.readPublishedFile(packageId, revision, filepath);
  }

  async resolvePublishedFile(
    packageId: number,
    revision: number,
    filepath: string,
  ): Promise<{ path: string; size: number }> {
    await assertPublishedFile(
      this.revisionsRepository,
      packageId,
      revision,
      filepath,
    );
    return this.storage.resolvePublishedFile(packageId, revision, filepath);
  }

  async findRevision(
    packageId: number,
    revision: number,
  ): Promise<ScriptingPackageRevision> {
    const row = await this.revisionsRepository.findOne({
      where: { package: { id: packageId }, revision },
    });
    if (!row) {
      throw new NotFoundException(
        `Revision ${revision} of package ${packageId} not found`,
      );
    }
    return row;
  }

  /**
   * A newer draft replaces the unfinished one. The old row is kept as
   * `discarded` instead of being deleted, so revision numbers are never reused
   * and a stale upload session cannot publish into somebody else's row.
   */
  private async discardDrafts(packageId: number): Promise<void> {
    const drafts = await this.revisionsRepository.find({
      where: { package: { id: packageId }, status: 'draft' },
    });
    if (drafts.length === 0) {
      return;
    }

    for (const draft of drafts) {
      draft.status = 'discarded';
      await this.revisionsRepository.save(draft);
      await this.storage.discardDraft(packageId, draft.revision);
    }
  }
}

function toManifest(
  row: ScriptingPackageRevision,
  packageId: number,
  packageName: string,
): PackageManifest {
  return {
    packageId,
    name: packageName,
    revision: row.revision,
    files: row.files,
    totalSize: row.files.reduce((sum, entry) => sum + entry.size, 0),
    publishedAt: row.publishedAt!.toISOString(),
  };
}

function toRevision(
  row: ScriptingPackageRevision,
  packageId: number,
): PackageRevision {
  return {
    packageId,
    revision: row.revision,
    status: row.status,
    files: row.files,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

async function assertPublishedFile(
  repository: Repository<ScriptingPackageRevision>,
  packageId: number,
  revision: number,
  filepath: string,
): Promise<void> {
  const row = await repository.findOne({
    where: { package: { id: packageId }, revision },
  });
  if (!row) {
    throw new NotFoundException(
      `Revision ${revision} of package ${packageId} not found`,
    );
  }
  if (row.status !== 'published') {
    throw new NotFoundException(
      `Revision ${revision} of package ${packageId} is not published`,
    );
  }
  if (
    !row.files.some((entry: PackageFileEntry) => entry.filepath === filepath)
  ) {
    throw new NotFoundException(
      `File ${filepath} is not declared in revision ${revision}`,
    );
  }
}
