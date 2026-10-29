import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PackageFileEntry } from '@wired-io/shared';
import { existsSync } from 'fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import path from 'path';
import { AppConfigService } from 'src/config/config.service';
import { sha256File, sha256Hex } from './package-hash';
import { resolvePackagePath } from './package-path';

const DRAFTS_DIR = 'drafts';
const REVISIONS_DIR = 'revisions';

export type SavedDraftFile = {
  size: number;
  sha256: string;
};

/**
 * File storage for package revisions.
 *
 * Every package owns its own directory inside the configured packages
 * storage root:
 *
 *   <packagesFilesDir>/<packageId>/drafts/<revision>/...
 *   <packagesFilesDir>/<packageId>/revisions/<revision>/...
 *
 * A draft can be written file by file and is disposable. A published
 * revision is immutable: publishing verifies every file against the manifest
 * and then moves the whole draft directory into `revisions`, so a partially
 * uploaded or failed revision can never be served as published.
 */
@Injectable()
export class PackageStorageService {
  constructor(private readonly configService: AppConfigService) {}

  private get rootDir(): string {
    return this.configService.storage.packagesFilesDir;
  }

  packageRootDir(packageId: number): string {
    return path.join(this.rootDir, String(packageId));
  }

  draftRevisionDir(packageId: number, revision: number): string {
    return path.join(
      this.packageRootDir(packageId),
      DRAFTS_DIR,
      String(revision),
    );
  }

  publishedRevisionDir(packageId: number, revision: number): string {
    return path.join(
      this.packageRootDir(packageId),
      REVISIONS_DIR,
      String(revision),
    );
  }

  async saveDraftFile(
    packageId: number,
    revision: number,
    filepath: string,
    data: Buffer,
  ): Promise<SavedDraftFile> {
    const target = resolvePackagePath(
      this.draftRevisionDir(packageId, revision),
      filepath,
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    return { size: data.byteLength, sha256: sha256Hex(data) };
  }

  /**
   * Lists files of a draft revision as sorted, posix-separated relative paths.
   * A draft that was never written reports an empty list.
   */
  async listDraftFiles(packageId: number, revision: number): Promise<string[]> {
    return this.listFilesRecursive(this.draftRevisionDir(packageId, revision));
  }

  async listPublishedFiles(
    packageId: number,
    revision: number,
  ): Promise<string[]> {
    return this.listFilesRecursive(
      this.publishedRevisionDir(packageId, revision),
    );
  }

  publishedRevisionExists(packageId: number, revision: number): boolean {
    return existsSync(this.publishedRevisionDir(packageId, revision));
  }

  /**
   * Publishes a draft revision.
   *
   * Verifies that the draft contains exactly the declared files with the
   * declared sizes and sha256 hashes, then moves the directory into the
   * immutable published location and runs `commit` (the database transaction).
   * When `commit` fails the directory is moved back to the draft location.
   */
  async publishRevision(
    packageId: number,
    revision: number,
    declared: PackageFileEntry[],
    commit: () => Promise<void>,
  ): Promise<void> {
    const draftDir = this.draftRevisionDir(packageId, revision);
    const draftFiles = await this.listFilesRecursive(draftDir);

    if (draftFiles.length === 0) {
      throw new BadRequestException(
        `Revision ${revision} has no uploaded files`,
      );
    }

    const declaredPaths = new Set(declared.map((entry) => entry.filepath));
    const uploadedPaths = new Set(draftFiles);

    const missing = [...declaredPaths].filter(
      (filepath) => !uploadedPaths.has(filepath),
    );
    if (missing.length > 0) {
      throw new BadRequestException(
        `Cannot publish revision, missing files: ${missing.join(', ')}`,
      );
    }

    const unexpected = [...uploadedPaths].filter(
      (filepath) => !declaredPaths.has(filepath),
    );
    if (unexpected.length > 0) {
      throw new BadRequestException(
        `Cannot publish revision, unexpected files: ${unexpected.join(', ')}`,
      );
    }

    for (const entry of declared) {
      const fullPath = resolvePackagePath(draftDir, entry.filepath);
      const actualSize = (await stat(fullPath)).size;
      if (actualSize !== entry.size) {
        throw new BadRequestException(
          `Cannot publish revision, size mismatch for ${entry.filepath}: expected ${entry.size}, got ${actualSize}`,
        );
      }
      const actualHash = await sha256File(fullPath);
      if (actualHash !== entry.sha256.toLowerCase()) {
        throw new BadRequestException(
          `Cannot publish revision, sha256 mismatch for ${entry.filepath}`,
        );
      }
    }

    const publishedDir = this.publishedRevisionDir(packageId, revision);
    if (existsSync(publishedDir)) {
      throw new ConflictException(
        `Revision ${revision} is already published and cannot be replaced`,
      );
    }

    await mkdir(path.dirname(publishedDir), { recursive: true });
    await rename(draftDir, publishedDir);

    try {
      await commit();
    } catch (error) {
      await rename(publishedDir, draftDir);
      throw error;
    }
  }

  async readPublishedFile(
    packageId: number,
    revision: number,
    filepath: string,
  ): Promise<Buffer> {
    const fullPath = resolvePackagePath(
      this.publishedRevisionDir(packageId, revision),
      filepath,
    );
    try {
      return await readFile(fullPath);
    } catch {
      throw new NotFoundException(`File ${filepath} is not published`);
    }
  }

  async discardDraft(packageId: number, revision: number): Promise<void> {
    await this.removeDirectory(this.draftRevisionDir(packageId, revision));
  }

  async discardPublished(packageId: number, revision: number): Promise<void> {
    await this.removeDirectory(this.publishedRevisionDir(packageId, revision));
  }

  private async removeDirectory(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }

  private async listFilesRecursive(dir: string): Promise<string[]> {
    const result: string[] = [];
    const walk = async (current: string, prefix: string): Promise<void> => {
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of entries) {
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
          await walk(path.join(current, item.name), relative);
        } else {
          result.push(relative);
        }
      }
    };
    await walk(dir, '');
    return result.sort();
  }
}
