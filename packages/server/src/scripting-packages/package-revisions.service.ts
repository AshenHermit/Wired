import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  CreatePackageRevisionPayload,
  PackageFileEntry,
  PackageManifest,
  PackageRevision,
} from '@wired-io/shared';
import { Repository } from 'typeorm';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import {
  SavedDraftFile,
  PackageStorageService,
} from './package-storage.service';
import { validatePackageRevisionFiles } from './package-manifest';
import { ScriptingPackagesService } from './scripting-packages.service';

/**
 * Draft and published revisions of a scripting package.
 *
 * Only file bytes live in the storage directory; the declared manifest lives
 * in Postgres. A revision becomes visible to players (`published`) only after
 * every declared file was verified on disk by {@link PackageStorageService}.
 */
@Injectable()
export class PackageRevisionsService {
  /** Packages whose bytes are being verified and moved right now. */
  private readonly publishing = new Set<number>();

  constructor(
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisionsRepository: Repository<ScriptingPackageRevision>,
    private readonly packagesService: ScriptingPackagesService,
    private readonly storage: PackageStorageService,
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
    if (this.publishing.has(packageId)) {
      throw new ConflictException(
        `Package ${packageId} is being published, try again in a moment`,
      );
    }

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
    if (this.publishing.has(packageId)) {
      throw new ConflictException(
        `Package ${packageId} is being published, try again in a moment`,
      );
    }

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
    }

    return toRevision(row, packageId);
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
    const row = await this.findRevision(packageId, revision);

    if (row.status !== 'published') {
      throw new NotFoundException(
        `Revision ${revision} of package ${packageId} is not published`,
      );
    }

    const declared = row.files.some(
      (entry: PackageFileEntry) => entry.filepath === filepath,
    );
    if (!declared) {
      throw new NotFoundException(
        `File ${filepath} is not declared in revision ${revision}`,
      );
    }

    return this.storage.readPublishedFile(packageId, revision, filepath);
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
