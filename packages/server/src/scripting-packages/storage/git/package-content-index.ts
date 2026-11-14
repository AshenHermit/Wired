import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { PackageFileEntry } from '@wired-io/shared';
import type { Repository } from 'typeorm';
import { ScriptingPackageRevision } from '../../../database/entities/scripting-package-revision.entity';
import { PackageGitRepository } from './package-git-repository';

@Injectable()
export class PackageContentIndex {
  private readonly cache = new Map<number, Promise<Map<string, string>>>();

  constructor(
    private readonly repo: PackageGitRepository,
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisions: Repository<ScriptingPackageRevision>,
  ) {}

  async missing(
    packageId: number,
    files: PackageFileEntry[],
  ): Promise<string[]> {
    const index = await this.load(packageId);
    return files
      .filter((file) => !index.has(file.sha256.toLowerCase()))
      .map((file) => file.filepath);
  }

  async resolveOids(
    packageId: number,
    files: PackageFileEntry[],
  ): Promise<Map<string, string>> {
    const index = await this.load(packageId);
    const result = new Map<string, string>();
    for (const file of files) {
      const oid = index.get(file.sha256.toLowerCase());
      if (!oid) {
        throw new ConflictException({
          code: 'package_storage_stale',
          message: 'Package files must be uploaded again',
        });
      }
      result.set(file.filepath, oid);
    }
    return result;
  }

  register(
    packageId: number,
    entries: Array<{ filepath: string; sha256: string; oid: string }>,
  ): void {
    const cached = this.cache.get(packageId);
    if (!cached) {
      return;
    }
    void cached.then((index) => {
      if (this.cache.get(packageId) !== cached) {
        return;
      }
      for (const entry of entries) {
        index.set(entry.sha256.toLowerCase(), entry.oid);
      }
    });
  }

  invalidate(packageId: number): void {
    this.cache.delete(packageId);
  }

  private load(packageId: number): Promise<Map<string, string>> {
    const cached = this.cache.get(packageId);
    if (cached) {
      return cached;
    }
    const built = this.build(packageId).catch((error: unknown) => {
      if (this.cache.get(packageId) === built) {
        this.cache.delete(packageId);
      }
      throw error;
    });
    this.cache.set(packageId, built);
    return built;
  }

  private async build(packageId: number): Promise<Map<string, string>> {
    const rows = await this.revisions.find({
      where: { package: { id: packageId }, status: 'published' },
    });
    const index = new Map<string, string>();
    for (const row of rows) {
      const commit =
        row.commitSha ??
        (await this.repo.readRef(
          packageId,
          `refs/tags/revisions/${row.revision}`,
        ));
      if (!commit) {
        continue;
      }
      const tree = await this.repo.listTree(packageId, commit);
      for (const file of row.files ?? []) {
        const oid = tree.get(file.filepath);
        if (oid) {
          index.set(file.sha256.toLowerCase(), oid);
        }
      }
    }
    const existing = await this.repo.objectExists(packageId, [
      ...new Set(index.values()),
    ]);
    for (const [sha256, oid] of [...index]) {
      if (!existing.has(oid)) {
        index.delete(sha256);
      }
    }
    return index;
  }
}
