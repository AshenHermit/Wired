import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppConfigService } from 'src/config/config.service';
import { GitCommand } from './git-command';

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
