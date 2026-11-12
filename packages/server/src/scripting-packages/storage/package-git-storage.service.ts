import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { PackageFileEntry } from '@wired-io/shared';
import { existsSync } from 'fs';
import { readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { Readable } from 'node:stream';
import { errorMessage } from 'src/common/errors';
import { sha256File } from './package-hash';
import { PackageContentIndex } from './git/package-content-index';
import type { GitAuthor } from './git/package-git-types';
import { PackageGitRepository } from './git/package-git-repository';

export interface PublishRevisionInput {
  packageId: number;
  revision: number;
  declared: PackageFileEntry[];
  stagedDir: string;
  author: GitAuthor;
  commitDb: (commitSha: string) => Promise<void>;
}

@Injectable()
export class PackageGitStorageService {
  private readonly logger = new Logger(PackageGitStorageService.name);

  constructor(
    private readonly repo: PackageGitRepository,
    @Optional() private readonly index?: PackageContentIndex,
  ) {}

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

  async missingFiles(
    packageId: number,
    files: PackageFileEntry[],
  ): Promise<string[]> {
    if (!this.index) {
      return [];
    }
    return this.index.missing(packageId, files);
  }

  async publish(input: PublishRevisionInput): Promise<string> {
    const index = this.index;
    if (!index) {
      throw new Error('package content index is not available');
    }
    const { packageId, revision, declared, stagedDir, author, commitDb } =
      input;
    await this.repo.ensureRepo(packageId);
    const stagedPaths = await this.assertStagedSubset(stagedDir, declared);
    const stagedSet = new Set(stagedPaths);
    const staged = declared.filter((file) => stagedSet.has(file.filepath));
    const skipped = declared.filter((file) => !stagedSet.has(file.filepath));

    const oids = new Map<string, string>();
    if (staged.length > 0) {
      const written = await this.repo.writeStagedBlobs(
        packageId,
        staged.map((file) => ({
          path: file.filepath,
          absolute: join(stagedDir, file.filepath),
        })),
      );
      for (const [filepath, oid] of written) {
        oids.set(filepath, oid);
      }
    }
    if (skipped.length > 0) {
      const resolved = await index.resolveOids(packageId, skipped);
      for (const [filepath, oid] of resolved) {
        oids.set(filepath, oid);
      }
    }

    const tree = await this.repo.writeTree(
      packageId,
      declared.map((file) => ({
        path: file.filepath,
        oid: this.requireOid(oids, file.filepath),
      })),
    );
    const parent = await this.previousCommit(packageId, revision);
    const commit = await this.repo.createCommit(
      packageId,
      tree,
      parent,
      author,
      `revision ${revision}`,
      new Date(),
    );

    const pending = `refs/pending/publish/${revision}`;
    await this.repo.applyRefUpdates(packageId, [
      { ref: pending, oid: commit, expected: null },
    ]);
    try {
      await commitDb(commit);
    } catch (error) {
      await this.repo
        .applyRefUpdates(packageId, [
          { ref: pending, delete: true, expected: commit },
        ])
        .catch(() => undefined);
      throw error;
    }

    try {
      await this.repo.applyRefUpdates(packageId, [
        {
          ref: `refs/tags/revisions/${revision}`,
          oid: commit,
          expected: null,
        },
        {
          ref: 'refs/heads/main',
          oid: commit,
          expected: parent,
        },
        { ref: pending, delete: true, expected: commit },
      ]);
    } catch (error) {
      this.logger.error(
        `Revision ${revision} of package ${packageId} is committed but refs were not promoted: ${errorMessage(error)}`,
      );
      return commit;
    }

    index.register(
      packageId,
      declared.map((file) => ({
        filepath: file.filepath,
        sha256: file.sha256,
        oid: this.requireOid(oids, file.filepath),
      })),
    );
    await rm(stagedDir, { recursive: true, force: true }).catch(() => undefined);
    return commit;
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

  private async assertStagedSubset(
    stagedDir: string,
    declared: PackageFileEntry[],
  ): Promise<string[]> {
    if (!existsSync(stagedDir)) {
      return [];
    }
    const uploaded = await listFilesRecursive(stagedDir);
    const declaredByPath = new Map(declared.map((file) => [file.filepath, file]));
    for (const filepath of uploaded) {
      const entry = declaredByPath.get(filepath);
      if (!entry) {
        throw new BadRequestException(
          `Cannot publish revision, unexpected files: ${filepath}`,
        );
      }
      const absolute = join(stagedDir, filepath);
      const info = await stat(absolute);
      if (info.size !== entry.size) {
        throw new BadRequestException(
          `Cannot publish revision, size mismatch for ${filepath}`,
        );
      }
      const sha256 = await sha256File(absolute);
      if (sha256 !== entry.sha256.toLowerCase()) {
        throw new BadRequestException(
          `Cannot publish revision, sha256 mismatch for ${filepath}`,
        );
      }
    }
    return uploaded;
  }

  private async previousCommit(
    packageId: number,
    revision: number,
  ): Promise<string | null> {
    const refs = await this.repo.listRefs(
      packageId,
      'refs/tags/revisions/',
    );
    let best = -1;
    let oid: string | null = null;
    for (const entry of refs) {
      const value = Number(entry.ref.split('/').pop());
      if (Number.isInteger(value) && value < revision && value > best) {
        best = value;
        oid = entry.oid;
      }
    }
    return oid;
  }

  private requireOid(oids: Map<string, string>, filepath: string): string {
    const oid = oids.get(filepath);
    if (!oid) {
      throw new BadRequestException(
        `Cannot publish revision, file ${filepath} was not uploaded`,
      );
    }
    return oid;
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

async function listFilesRecursive(dir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursive(absolute);
      for (const file of nested) {
        result.push(`${entry.name}/${file}`);
      }
    } else {
      result.push(entry.name);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}
