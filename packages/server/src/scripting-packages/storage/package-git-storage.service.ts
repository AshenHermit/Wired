import { Injectable, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { PackageGitRepository } from './git/package-git-repository';

@Injectable()
export class PackageGitStorageService {
  constructor(private readonly repo: PackageGitRepository) {}

  async isGitPackage(packageId: number): Promise<boolean> {
    return this.repo.hasRepo(packageId);
  }

  async resolveCommit(
    packageId: number,
    revision: number,
    commitSha: string | null = null,
  ): Promise<string | null> {
    if (!(await this.repo.hasRepo(packageId))) {
      return null;
    }
    if (commitSha) {
      const existing = await this.repo.objectExists(packageId, [commitSha]);
      if (existing.has(commitSha)) {
        return commitSha;
      }
    }
    return this.repo.readRef(
      packageId,
      `refs/tags/revisions/${revision}`,
    );
  }

  async readFile(
    packageId: number,
    revision: number,
    filepath: string,
    commitSha: string | null = null,
  ): Promise<Buffer> {
    const files = await this.readFiles(
      packageId,
      revision,
      [filepath],
      commitSha,
    );
    const data = files.get(filepath);
    if (!data) {
      throw new NotFoundException(
        `File ${filepath} not found in revision ${revision}`,
      );
    }
    return data;
  }

  async readFiles(
    packageId: number,
    revision: number,
    filepaths: string[],
    commitSha: string | null = null,
  ): Promise<Map<string, Buffer>> {
    const result = new Map<string, Buffer>();
    if (filepaths.length === 0) {
      return result;
    }
    const commit = await this.requireCommit(packageId, revision, commitSha);
    const tree = await this.repo.listTree(packageId, commit);
    const oids = filepaths.map((filepath) => {
      const oid = tree.get(filepath);
      if (!oid) {
        throw new NotFoundException(
          `File ${filepath} not found in revision ${revision}`,
        );
      }
      return oid;
    });
    let cursor = 0;
    await this.repo.forEachBlob(packageId, oids, (_oid, data) => {
      const filepath = filepaths[cursor];
      cursor += 1;
      if (filepath) {
        result.set(filepath, data);
      }
    });
    return result;
  }

  async readTextFiles(
    packageId: number,
    revision: number,
    filepaths: string[],
    commitSha: string | null = null,
  ): Promise<Map<string, string>> {
    const files = await this.readFiles(
      packageId,
      revision,
      filepaths,
      commitSha,
    );
    const result = new Map<string, string>();
    for (const [filepath, data] of files) {
      result.set(filepath, data.toString('utf8'));
    }
    return result;
  }

  async openFile(
    packageId: number,
    revision: number,
    filepath: string,
    commitSha: string | null = null,
  ): Promise<Readable> {
    return Readable.from(
      await this.readFile(packageId, revision, filepath, commitSha),
    );
  }

  async fileSize(
    packageId: number,
    revision: number,
    filepath: string,
    commitSha: string | null = null,
  ): Promise<number> {
    const oid = await this.resolveBlob(packageId, revision, filepath, commitSha);
    return this.repo.blobSize(packageId, oid);
  }

  private async resolveBlob(
    packageId: number,
    revision: number,
    filepath: string,
    commitSha: string | null,
  ): Promise<string> {
    const commit = await this.requireCommit(packageId, revision, commitSha);
    const tree = await this.repo.listTree(packageId, commit);
    const oid = tree.get(filepath);
    if (!oid) {
      throw new NotFoundException(
        `File ${filepath} not found in revision ${revision}`,
      );
    }
    return oid;
  }

  private async requireCommit(
    packageId: number,
    revision: number,
    commitSha: string | null,
  ): Promise<string> {
    const commit = await this.resolveCommit(packageId, revision, commitSha);
    if (!commit) {
      throw new NotFoundException(`Revision ${revision} has no git commit`);
    }
    return commit;
  }
}
