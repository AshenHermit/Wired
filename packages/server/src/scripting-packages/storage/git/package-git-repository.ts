import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppConfigService } from 'src/config/config.service';
import { GitCommand } from './git-command';
import { GitAuthor } from './package-git-types';

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

const MIN_GIT_MINOR = 29;

/**
 * Owns the bare git repository of each package.
 *
 * Repositories are initialized with `object-format=sha256`; the object format
 * cannot be changed after creation, so a pre-existing sha1 repository is a
 * hard error rather than a silent downgrade.
 */
@Injectable()
export class PackageGitRepository implements OnModuleInit {
  private readonly logger = new Logger(PackageGitRepository.name);
  private readonly treeCache = new Map<string, Map<string, string>>();
  private static readonly TREE_CACHE_LIMIT = 50;

  constructor(
    private readonly config: AppConfigService,
    public readonly command: GitCommand,
  ) {}

  get enabled(): boolean {
    return this.config.packages.gitStorage;
  }

  packageRootDir(packageId: number): string {
    return join(this.config.storage.packagesFilesDir, String(packageId));
  }

  repoDir(packageId: number): string {
    return join(this.packageRootDir(packageId), 'repo.git');
  }

  async hasRepo(packageId: number): Promise<boolean> {
    try {
      const entry = await stat(this.repoDir(packageId));
      return entry.isDirectory();
    } catch {
      return false;
    }
  }

  async ensureRepo(packageId: number): Promise<void> {
    const root = this.packageRootDir(packageId);
    await mkdir(root, { recursive: true });
    if (await this.hasRepo(packageId)) {
      return;
    }

    const hooksDir = join(root, 'tmp', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const repoDir = this.repoDir(packageId);
    await this.command.run(
      ['init', '--bare', '--object-format=sha256', repoDir],
      { cwd: root },
    );
    const settings: Array<[string, string]> = [
      ['core.autocrlf', 'false'],
      ['core.symlinks', 'false'],
      ['core.fsmonitor', 'false'],
      ['gc.auto', '0'],
      ['core.hooksPath', hooksDir],
    ];
    for (const [key, value] of settings) {
      await this.command.run(['config', key, value], { cwd: repoDir });
    }
    this.clearTreeCache(packageId);
    this.logger.log(`Initialized package git repository ${repoDir}`);
  }

  async version(): Promise<GitVersion> {
    await mkdir(this.config.storage.packagesFilesDir, { recursive: true });
    const raw = (
      await this.command.run(['--version'], {
        cwd: this.config.storage.packagesFilesDir,
      })
    )
      .toString()
      .trim();
    const match = /^git version (\d+)\.(\d+)\.(\d+)/.exec(raw);
    if (!match) {
      throw new Error(`Unrecognized git version output: ${raw}`);
    }
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      raw,
    };
  }

  async writeBlobs(
    packageId: number,
    files: Array<{ path: string; data: Buffer }>,
  ): Promise<Map<string, string>> {
    if (files.length === 0) {
      return new Map();
    }
    const directory = join(
      this.packageRootDir(packageId),
      'tmp',
      'blobs',
      randomUUID(),
    );
    await mkdir(directory, { recursive: true });
    try {
      const staged: Array<{ path: string; absolute: string }> = [];
      for (const [index, file] of files.entries()) {
        const absolute = join(directory, String(index));
        await writeFile(absolute, file.data);
        staged.push({ path: file.path, absolute });
      }
      return await this.writeStagedBlobs(packageId, staged);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async writeStagedBlobs(
    packageId: number,
    files: Array<{ path: string; absolute: string }>,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const batchSize = 200;
    for (let offset = 0; offset < files.length; offset += batchSize) {
      const batch = files.slice(offset, offset + batchSize);
      const output = await this.command.run(
        ['hash-object', '-w', '--stdin-paths'],
        {
          cwd: this.repoDir(packageId),
          input: `${batch.map((file) => file.absolute).join('\n')}\n`,
        },
      );
      const oids = output.toString().trim().split('\n');
      if (oids.length !== batch.length) {
        throw new Error(
          `Expected ${batch.length} object ids, got ${oids.length}`,
        );
      }
      for (const [index, file] of batch.entries()) {
        const oid = oids[index].trim();
        if (!/^[0-9a-f]{64}$/.test(oid)) {
          throw new Error(
            `Unexpected object id for ${file.path}: ${JSON.stringify(oid)}`,
          );
        }
        result.set(file.path, oid);
      }
    }
    return result;
  }

  async writeTree(
    packageId: number,
    entries: Array<{ path: string; oid: string }>,
  ): Promise<string> {
    const indexFile = join(
      this.packageRootDir(packageId),
      'tmp',
      `index-${randomUUID()}`,
    );
    await mkdir(dirname(indexFile), { recursive: true });
    const sorted = [...entries].sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    );
    const input = sorted
      .map((entry) => `100644 blob ${entry.oid}\t${entry.path}\0`)
      .join('');
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.command.run(['update-index', '-z', '--index-info'], {
        cwd: this.repoDir(packageId),
        input,
        env,
      });
      const tree = (
        await this.command.run(['write-tree'], {
          cwd: this.repoDir(packageId),
          env,
        })
      )
        .toString()
        .trim();
      if (!/^[0-9a-f]{64}$/.test(tree)) {
        throw new Error(`Unexpected tree id: ${JSON.stringify(tree)}`);
      }
      return tree;
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  async createCommit(
    packageId: number,
    tree: string,
    parent: string | null,
    author: GitAuthor,
    message: string,
    date: Date,
  ): Promise<string> {
    const timestamp = Math.floor(date.getTime() / 1000);
    const dateValue = `${timestamp} +0000`;
    const args = ['commit-tree', tree];
    if (parent) {
      args.push('-p', parent);
    }
    args.push('-m', message);
    const commit = (
      await this.command.run(args, {
        cwd: this.repoDir(packageId),
        env: {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
          GIT_AUTHOR_DATE: dateValue,
          GIT_COMMITTER_DATE: dateValue,
        },
      })
    )
      .toString()
      .trim();
    if (!/^[0-9a-f]{64}$/.test(commit)) {
      throw new Error(`Unexpected commit id: ${JSON.stringify(commit)}`);
    }
    return commit;
  }

  async listTree(
    packageId: number,
    commit: string,
  ): Promise<Map<string, string>> {
    const key = `${packageId}:${commit}`;
    const cached = this.treeCache.get(key);
    if (cached) {
      this.treeCache.delete(key);
      this.treeCache.set(key, cached);
      return cached;
    }

    const output = await this.command.run(
      ['ls-tree', '-r', '-z', '--full-tree', commit],
      { cwd: this.repoDir(packageId) },
    );
    const files = new Map<string, string>();
    for (const entry of output.toString().split('\0')) {
      if (!entry) {
        continue;
      }
      const tab = entry.indexOf('\t');
      if (tab < 0) {
        throw new Error(`Malformed tree entry: ${entry}`);
      }
      const [mode, type, oid] = entry.slice(0, tab).split(' ');
      const filepath = entry.slice(tab + 1);
      if (mode !== '100644' || type !== 'blob') {
        throw new Error(`non-regular tree entry: ${filepath}`);
      }
      files.set(filepath, oid);
    }

    this.treeCache.set(key, files);
    if (this.treeCache.size > PackageGitRepository.TREE_CACHE_LIMIT) {
      const oldest = this.treeCache.keys().next().value;
      if (oldest !== undefined) {
        this.treeCache.delete(oldest);
      }
    }
    return files;
  }

  async objectExists(packageId: number, oids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (oids.length === 0) {
      return found;
    }
    const output = await this.command.run(['cat-file', '--batch-check'], {
      cwd: this.repoDir(packageId),
      input: `${oids.join('\n')}\n`,
    });
    for (const line of output.toString().trim().split('\n')) {
      const [oid, type] = line.split(' ');
      if (type && type !== 'missing') {
        found.add(oid);
      }
    }
    return found;
  }

  clearTreeCache(packageId: number): void {
    const prefix = `${packageId}:`;
    for (const key of [...this.treeCache.keys()]) {
      if (key.startsWith(prefix)) {
        this.treeCache.delete(key);
      }
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const version = await this.version();
    if (version.major < 2 || (version.major === 2 && version.minor < MIN_GIT_MINOR)) {
      throw new Error('git >= 2.29 is required for package storage');
    }
  }
}
