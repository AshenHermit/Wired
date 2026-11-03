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
import { In, Repository } from 'typeorm';
import { errorMessage } from 'src/common/errors';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import {
  SavedDraftFile,
  PackageStorageService,
} from './package-storage.service';
import { sha256Hex } from './package-hash';
import { validatePackageRevisionFiles } from './package-manifest';
import { PackagePublishLockService } from './package-publish-lock.service';
import {
  collectRawPackageReferences,
  decodePackageText,
  isTextPackageFile,
  PackageFileReference,
  resolvePackageReferences,
} from './package-runtime-references';
import {
  loadPackageSlugIndex,
  PackageSlugIndex,
  requirePackageSlug,
} from './package-slug-index';
import { packageDependencyError } from './package-errors';
import { ScriptingPackagesService } from './scripting-packages.service';
import {
  PACKAGE_REVISION_DISPATCHER,
  PackageRevisionDispatcher,
} from 'src/common/runtime-contracts';

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

  constructor(
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisionsRepository: Repository<ScriptingPackageRevision>,
    private readonly packagesService: ScriptingPackagesService,
    private readonly storage: PackageStorageService,
    @Optional()
    private readonly locks?: PackagePublishLockService,
    @Optional()
    @Inject(PACKAGE_REVISION_DISPATCHER)
    private readonly dispatcher?: PackageRevisionDispatcher,
    @Optional()
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository?: Repository<ScriptingPackage>,
  ) {}

  /**
   * The publication guard is provided by `ScriptingPackagesModule`; it stays
   * optional only so specs can build the service without a database. Missing
   * it is a configuration error, not a reason to fall back to a private set.
   */
  private get publishLocks(): PackagePublishLockService {
    if (!this.locks) {
      throw new Error('package_publish_lock_missing');
    }
    return this.locks;
  }

  /**
   * Starts a new draft revision. Any unfinished draft of the same package is
   * discarded: only one draft exists per package at a time, so abandoned
   * uploads cannot accumulate or leak into a later publication.
   */
  async createDraft(
    packageId: number,
    payload: CreatePackageRevisionPayload,
  ): Promise<PackageRevision> {
    await this.publishLocks.assertNotPublishing(packageId);

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
    await this.publishLocks.assertNotPublishing(packageId);

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

    await this.assertNoDisabledRoomDependency(packageId, revision, row.files);

    // Loaded before the bytes move: a missing package must fail the publication
    // before it commits, and pins still resolve in the package's own room.
    const pkg = await this.packagesService.findOne(packageId);

    // Reject uploads for this package while its bytes are verified and moved.
    await this.publishLocks.runWithPublishLocks([packageId], async () => {
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
    });

    await this.recordPinnedDependencies(
      packageId,
      revision,
      row.files,
      pkg.room?.id ?? null,
    );
    await this.dispatchPublished(packageId, revision);
    return toRevision(row, packageId);
  }

  /**
   * Copies the latest published revision of one package into another as its
   * next revision.
   *
   * Used by every copy flow (workshop publish, fork, add to room): the bytes
   * are re-read from the source revision, optionally transformed, and then
   * published through the same manifest verification and lock as a regular
   * publication. Changing only the slug of a package keeps self-references
   * valid, so the copy owns its files instead of pointing at the source.
   *
   * The target's scope decides which references are allowed: a global
   * (workshop) target must only depend on global packages and a room target
   * must not depend on a package disabled in its own room.
   */
  async publishCopiedRevision(args: {
    sourcePackageId: number;
    targetPackageId: number;
    transformFile?: (filepath: string, data: Buffer) => Buffer;
  }): Promise<PackageRevision> {
    const { sourcePackageId, targetPackageId, transformFile } = args;

    const source = await this.revisionsRepository.findOne({
      where: { package: { id: sourcePackageId }, status: 'published' },
      order: { revision: 'DESC' },
    });
    if (!source) {
      throw new ConflictException({ code: 'package_not_published' });
    }

    const target = await this.packagesService.findOne(targetPackageId);
    const scopeRoomId = target.room?.id ?? null;

    const files: PackageFileEntry[] = [];
    const contents: Array<{ filepath: string; data: Buffer }> = [];
    for (const sourceFile of source.files) {
      const original = await this.storage.readPublishedFile(
        sourcePackageId,
        source.revision,
        sourceFile.filepath,
      );
      const data = transformFile
        ? transformFile(sourceFile.filepath, original)
        : original;
      files.push({
        filepath: sourceFile.filepath,
        size: data.byteLength,
        sha256: sha256Hex(data),
      });
      contents.push({ filepath: sourceFile.filepath, data });
    }

    const revision =
      ((await this.revisionsRepository.maximum('revision', {
        package: { id: targetPackageId },
      })) ?? 0) + 1;

    const saved = await this.revisionsRepository.save(
      this.revisionsRepository.create({
        package: { id: targetPackageId },
        revision,
        status: 'draft',
        files,
        publishedAt: null,
      }),
    );

    try {
      for (const copied of contents) {
        await this.storage.saveDraftFile(
          targetPackageId,
          revision,
          copied.filepath,
          copied.data,
        );
      }

      if (scopeRoomId === null) {
        await this.assertNoRoomDependency(targetPackageId, revision, files);
      } else {
        await this.assertNoDisabledRoomDependency(
          targetPackageId,
          revision,
          files,
        );
      }

      // Reject uploads for the target while its bytes are verified and moved.
      await this.publishLocks.runWithPublishLocks([targetPackageId], async () => {
        await this.storage.publishRevision(
          targetPackageId,
          revision,
          files,
          async () => {
            saved.status = 'published';
            saved.publishedAt = new Date();
            await this.revisionsRepository.save(saved);
          },
        );
      });
    } catch (error) {
      // The store rolls its own bytes back, but neither the row nor the draft
      // directory is: a leftover draft would make a retry that declares a
      // different file set unpublishable. Cleanup must never replace the
      // original publication error, so a failure there is only logged.
      try {
        await this.revisionsRepository.delete(saved.id);
      } catch (cleanupError) {
        this.warnCopyCleanupFailure(targetPackageId, revision, cleanupError);
      }
      try {
        await this.storage.discardDraft(targetPackageId, revision);
      } catch (cleanupError) {
        this.warnCopyCleanupFailure(targetPackageId, revision, cleanupError);
      }
      throw error;
    }

    await this.recordPinnedDependencies(
      targetPackageId,
      revision,
      files,
      scopeRoomId,
    );
    await this.dispatchPublished(targetPackageId, revision);
    return toRevision(saved, targetPackageId);
  }

  /**
   * A global (workshop) revision is later copied into arbitrary rooms, so its
   * pins must address global packages only: a room package id means nothing
   * outside its own room. Slugs are scoped too, so a package of a room is
   * reached here by its numeric id; the loaded row tells us its scope.
   */
  private async assertNoRoomDependency(
    packageId: number,
    revision: number,
    files: PackageFileEntry[],
  ): Promise<void> {
    if (!this.packagesRepository) {
      return;
    }

    const index = await this.slugIndex();
    const referenced = new Set<number>();
    for (const sourceFile of files) {
      if (!isTextPackageFile(sourceFile.filepath)) {
        continue;
      }
      let text: string;
      try {
        text = await this.storage.readDraftFile(
          packageId,
          revision,
          sourceFile.filepath,
        );
      } catch {
        // A missing upload is reported by publishRevision's own check.
        continue;
      }
      for (const reference of this.resolveReferences(text, index, null)) {
        referenced.add(reference.packageId);
      }
    }

    if (referenced.size === 0) {
      return;
    }
    const dependencies = await this.packagesRepository.find({
      where: { id: In([...referenced]) },
      relations: { room: true },
    });
    const roomScoped = dependencies.find(
      (dependency) => dependency.room !== null && dependency.room !== undefined,
    );
    if (!roomScoped) {
      return;
    }
    throw packageDependencyError(
      'package_dependency_not_global',
      `Package "${requirePackageSlug(roomScoped)}" belongs to a room, so it cannot be a dependency of a published package.`,
      { slug: requirePackageSlug(roomScoped) },
    );
  }

  /**
   * Publishing pins every package the sources reference, directly or through
   * another package's own pins, and the artifact builder rewrites those
   * references into the dependency's runtime directory. Publishing against a
   * dependency disabled in the same room would therefore produce an artifact
   * that can never load, so the publication is refused instead.
   */
  private async assertNoDisabledRoomDependency(
    packageId: number,
    revision: number,
    files: PackageFileEntry[],
  ): Promise<void> {
    if (!this.packagesRepository) {
      return;
    }

    const pkg = await this.packagesService.findOne(packageId);
    const scopeRoomId = pkg.room?.id ?? null;
    const index = await this.slugIndex();
    const referenced = new Set<number>();
    for (const entry of files) {
      if (!isTextPackageFile(entry.filepath)) {
        continue;
      }
      let text: string;
      try {
        text = await this.storage.readDraftFile(
          packageId,
          revision,
          entry.filepath,
        );
      } catch {
        // A missing upload is reported by publishRevision's own check.
        continue;
      }
      for (const reference of this.resolveReferences(
        text,
        index,
        scopeRoomId,
      )) {
        referenced.add(reference.packageId);
      }
    }

    const roomId = pkg.room?.id;
    if (roomId === undefined) {
      return;
    }

    const visited = new Set<number>();
    const queue: number[] = [];
    const visit = (id: number): void => {
      if (id === packageId || visited.has(id)) {
        return;
      }
      visited.add(id);
      queue.push(id);
    };

    for (const id of referenced) {
      visit(id);
    }

    while (queue.length > 0) {
      const id = queue.shift()!;
      const latest = await this.revisionsRepository.findOne({
        where: { package: { id }, status: 'published' },
        order: { revision: 'DESC' },
      });
      if (!latest) {
        continue;
      }
      const pins = await this.storage.readPinnedDependencies(
        id,
        latest.revision,
      );
      for (const pinned of pins?.keys() ?? []) {
        visit(pinned);
      }
    }

    if (visited.size === 0) {
      return;
    }
    const dependencies = await this.packagesRepository.find({
      where: { id: In([...visited]) },
      relations: { room: true },
    });
    const blocked = dependencies.find(
      (dependency) =>
        dependency.enabled === false && dependency.room?.id === roomId,
    );
    if (!blocked) {
      return;
    }
    throw new ConflictException({
      statusCode: 409,
      code: 'dependency_disabled',
      message: `Dependency ${blocked.id} is disabled in this room`,
      dependencyId: blocked.id,
      name: blocked.name,
    });
  }

  /**
   * Loads a fresh `slug <-> id` index for one publish operation. Without the
   * repository (unit tests) only numeric references can be resolved, which is
   * the legacy behaviour.
   */
  private async slugIndex(): Promise<PackageSlugIndex> {
    if (!this.packagesRepository) {
      return {
        byId: new Map(),
        byRoomSlug: new Map(),
        byGlobalSlug: new Map(),
      };
    }
    return loadPackageSlugIndex(this.packagesRepository);
  }

  /**
   * Resolves the references of one file against the scoped slug index. An
   * unknown slug is a hard publication error: the artifact could never be
   * rewritten to a runtime path, so publishing it would only move the failure
   * to the player.
   */
  private resolveReferences(
    text: string,
    index: PackageSlugIndex,
    scopeRoomId: number | null,
  ): PackageFileReference[] {
    const { resolved, unknown } = resolvePackageReferences(
      collectRawPackageReferences(text),
      index,
      scopeRoomId,
    );
    if (unknown.length > 0) {
      throw packageDependencyError(
        'package_dependency_unknown_slug',
        `Package "${unknown[0]}" is not available to this room.`,
        { slug: unknown[0] },
      );
    }
    return resolved;
  }

  private warnCopyCleanupFailure(
    packageId: number,
    revision: number,
    error: unknown,
  ): void {
    this.logger.warn(
      `Package ${packageId} revision ${revision} copy cleanup failed: ${
        errorMessage(error)
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
   *
   * Slugs resolve in the publishing package's room first, then globally, so a
   * pin points at the same package the artifact build will rewrite to.
   */
  private async recordPinnedDependencies(
    packageId: number,
    revision: number,
    files: PackageFileEntry[],
    scopeRoomId: number | null,
  ): Promise<void> {
    try {
      const index = await this.slugIndex();
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
        for (const ref of this.resolveReferences(text, index, scopeRoomId)) {
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
          errorMessage(error)
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
          errorMessage(error)
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

    return toManifest(row, packageId, pkg.name, requirePackageSlug(pkg));
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

    return toManifest(row, packageId, pkg.name, requirePackageSlug(pkg));
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
  packageSlug: string,
): PackageManifest {
  return {
    packageId,
    slug: packageSlug,
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
