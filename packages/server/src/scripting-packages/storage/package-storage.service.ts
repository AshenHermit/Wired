import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PackageFileEntry } from '@wired-io/shared';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'fs';
import {
  copyFile,
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
import { errorMessage } from 'src/common/errors';

const DRAFTS_DIR = 'drafts';
const REVISIONS_DIR = 'revisions';
/** Dependency pins recorded next to (not inside) each published revision. */
const PINS_DIR = 'pins';

export type SavedDraftFile = {
  size: number;
  sha256: string;
};

/** Which revision directory a rewrite works on. */
export type RevisionKind = 'published' | 'draft';

/** One revision directory that a rewrite touches. */
export interface RevisionTarget {
  packageId: number;
  revision: number;
  kind: RevisionKind;
}

/**
 * A rewrite whose bytes have moved but are not yet permanent.
 *
 * The originals stay beside the new tree until `commit` drops them, so `abort`
 * can put them back when the database update that justified the rewrite fails.
 * Either call is safe to make once.
 */
export interface RevisionRewrite {
  /** Targets whose directory existed and was rewritten, in target order. */
  readonly results: Array<{
    target: RevisionTarget;
    files: PackageFileEntry[];
  }>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

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
  private readonly logger = new Logger(PackageStorageService.name);

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

  /**
   * Records the revisions every direct dependency was pinned to when this
   * revision was published.
   *
   * Published revisions are immutable, so the closure resolved for them must
   * be immutable too: without this, the artifact key of one `(packageId,
   * revision)` pair would change every time a dependency publishes. The pins
   * live next to the revision (not inside it) so the published file set stays
   * exactly the declared manifest. Revisions published before pins existed
   * have no pin file and fall back to "latest published".
   */
  async writePinnedDependencies(
    packageId: number,
    revision: number,
    pins: ReadonlyMap<number, number>,
  ): Promise<void> {
    const target = this.pinnedDependenciesPath(packageId, revision);
    await mkdir(path.dirname(target), { recursive: true });
    const body = JSON.stringify({
      dependencies: [...pins.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([dependencyId, dependencyRevision]) => ({
          packageId: dependencyId,
          revision: dependencyRevision,
        })),
    });
    const staging =
      target +
      '.' +
      process.pid +
      '-' +
      randomBytes(4).toString('hex') +
      '.tmp';
    try {
      await writeFile(staging, body, 'utf8');
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Reads the dependency pins recorded for a published revision. Returns
   * `null` when no usable pin file exists, so callers fall back to the latest
   * published revision.
   */
  async readPinnedDependencies(
    packageId: number,
    revision: number,
  ): Promise<Map<number, number> | null> {
    let body: unknown;
    try {
      body = JSON.parse(
        await readFile(
          this.pinnedDependenciesPath(packageId, revision),
          'utf8',
        ),
      );
    } catch {
      return null;
    }
    const dependencies = (body as { dependencies?: unknown }).dependencies;
    if (!Array.isArray(dependencies)) {
      return null;
    }
    const pins = new Map<number, number>();
    for (const entry of dependencies as Array<{
      packageId?: unknown;
      revision?: unknown;
    }>) {
      if (
        typeof entry?.packageId === 'number' &&
        Number.isInteger(entry.packageId) &&
        typeof entry?.revision === 'number' &&
        Number.isInteger(entry.revision)
      ) {
        pins.set(entry.packageId, entry.revision);
      }
    }
    return pins;
  }

  private pinnedDependenciesPath(packageId: number, revision: number): string {
    return path.join(
      this.packageRootDir(packageId),
      PINS_DIR,
      revision + '.json',
    );
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

    await this.assertMatchesManifest(draftDir, revision, declared);

    const publishedDir = this.publishedRevisionDir(packageId, revision);
    if (existsSync(publishedDir)) {
      throw new ConflictException(
        `Revision ${revision} is already published and cannot be replaced`,
      );
    }

    await mkdir(path.dirname(publishedDir), { recursive: true });

    try {
      await rename(draftDir, publishedDir);
    } catch (error) {
      // A concurrent publish can win the rename; report it as a conflict
      // instead of a 500 and keep the bytes it already committed.
      if (existsSync(publishedDir)) {
        throw new ConflictException(
          `Revision ${revision} is already published and cannot be replaced`,
        );
      }
      throw error;
    }

    try {
      // Uploads are rejected while publishing, but re-verify the bytes that
      // will actually be served: a verified draft is not a verified revision.
      await this.assertMatchesManifest(publishedDir, revision, declared);
      await commit();
    } catch (error) {
      await rename(publishedDir, draftDir).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The uploaded files must be exactly the declared ones, byte for byte.
   */
  private async assertMatchesManifest(
    dir: string,
    revision: number,
    declared: PackageFileEntry[],
  ): Promise<void> {
    const files = await this.listFilesRecursive(dir);

    if (files.length === 0) {
      throw new BadRequestException(
        `Revision ${revision} has no uploaded files`,
      );
    }

    const declaredPaths = new Set(declared.map((entry) => entry.filepath));
    const uploadedPaths = new Set(files);

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
      const fullPath = resolvePackagePath(dir, entry.filepath);
      let actualSize: number;
      let actualHash: string;
      try {
        actualSize = (await stat(fullPath)).size;
        actualHash = await sha256File(fullPath);
      } catch {
        // The file can disappear between listing and verification; report a
        // client error instead of leaking ENOENT as a 500.
        throw new BadRequestException(
          `Cannot publish revision, file ${entry.filepath} is no longer available`,
        );
      }
      if (actualSize !== entry.size) {
        throw new BadRequestException(
          `Cannot publish revision, size mismatch for ${entry.filepath}: expected ${entry.size}, got ${actualSize}`,
        );
      }
      if (actualHash !== entry.sha256.toLowerCase()) {
        throw new BadRequestException(
          `Cannot publish revision, sha256 mismatch for ${entry.filepath}`,
        );
      }
    }
  }

  async resolvePublishedFile(
    packageId: number,
    revision: number,
    filepath: string,
  ): Promise<{ path: string; size: number }> {
    const fullPath = resolvePackagePath(
      this.publishedRevisionDir(packageId, revision),
      filepath,
    );
    try {
      const info = await stat(fullPath);
      if (!info.isFile()) {
        throw new NotFoundException(`File ${filepath} is not published`);
      }
      return { path: fullPath, size: info.size };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new NotFoundException(`File ${filepath} is not published`);
    }
  }

  async readPublishedFile(
    packageId: number,
    revision: number,
    filepath: string,
  ): Promise<Buffer> {
    const file = await this.resolvePublishedFile(packageId, revision, filepath);
    try {
      return await readFile(file.path);
    } catch {
      throw new NotFoundException(`File ${filepath} is not published`);
    }
  }

  /**
   * Reads a file of an unfinished draft. Publishing checks a package's own
   * draft sources for references to other packages before the bytes move to
   * the immutable published directory, so the draft is the only place these
   * files exist at that moment.
   */
  async readDraftFile(
    packageId: number,
    revision: number,
    filepath: string,
  ): Promise<string> {
    const fullPath = resolvePackagePath(
      this.draftRevisionDir(packageId, revision),
      filepath,
    );
    try {
      return await readFile(fullPath, 'utf8');
    } catch {
      throw new NotFoundException(`File ${filepath} is not in the draft`);
    }
  }

  async discardDraft(packageId: number, revision: number): Promise<void> {
    await this.removeDirectory(this.draftRevisionDir(packageId, revision));
  }

  /**
   * Rewrites several revisions as one unit.
   *
   * Every target's bytes move before the caller touches the database, and the
   * originals stay in place until `commit`, so a failure can restore them
   * instead of leaving a half-rewritten tree behind. A failure while rewriting
   * aborts whatever had already moved before the error leaves this method.
   */
  async beginRewrite(
    targets: readonly RevisionTarget[],
    transform: (filepath: string, data: Buffer) => Buffer,
  ): Promise<RevisionRewrite> {
    const attempted: RevisionTarget[] = [];
    const results: RevisionRewrite['results'] = [];
    try {
      for (const target of targets) {
        // Recorded before the rewrite so a target that fails part way through
        // still gets its backup restored.
        attempted.push(target);
        const files = await this.rewriteRevision(
          target.packageId,
          target.revision,
          target.kind,
          transform,
        );
        if (files) results.push({ target, files });
      }
    } catch (error) {
      await this.abortRewrites(attempted);
      throw error;
    }
    return {
      results,
      commit: () => this.finishRewrites(attempted),
      abort: () => this.abortRewrites(attempted),
    };
  }

  /**
   * Rewrites every file of one revision, phase one of three.
   *
   * The rewritten tree is prepared beside the live one and swapped, keeping the
   * original in `<revisionDir>.old` until `finishRewrite`: the database commit
   * of the new file manifest has to succeed before the backup goes away, or a
   * crash would leave bytes on disk that no manifest describes. Returns `null`
   * when the revision directory does not exist — a draft that was never
   * uploaded has nothing to rewrite.
   */
  async rewriteRevision(
    packageId: number,
    revision: number,
    kind: RevisionKind,
    transform: (filepath: string, data: Buffer) => Buffer,
  ): Promise<PackageFileEntry[] | null> {
    const dir = this.revisionDir(packageId, revision, kind);
    await this.recoverRewrite(dir);
    if (!existsSync(dir)) return null;

    const prepared = this.rewriteDir(dir);
    await this.removeDirectory(prepared);
    await this.copyDirectory(dir, prepared);

    const files: PackageFileEntry[] = [];
    for (const filepath of await this.listFilesRecursive(prepared)) {
      const fullPath = resolvePackagePath(prepared, filepath);
      const data = transform(filepath, await readFile(fullPath));
      await writeFile(fullPath, data);
      files.push({ filepath, size: data.byteLength, sha256: sha256Hex(data) });
    }

    const backup = this.rewriteBackupDir(dir);
    await this.removeDirectory(backup);
    await rename(dir, backup);
    try {
      await rename(prepared, dir);
    } catch (error) {
      await rename(backup, dir);
      throw error;
    }
    return files;
  }

  /** Phase two: the database now describes the rewritten bytes. */
  async finishRewrite(
    packageId: number,
    revision: number,
    kind: RevisionKind,
  ): Promise<void> {
    await this.removeDirectory(
      this.rewriteBackupDir(this.revisionDir(packageId, revision, kind)),
    );
  }

  /** Phase three: put the original bytes back after a failed update. */
  async abortRewrite(
    packageId: number,
    revision: number,
    kind: RevisionKind,
  ): Promise<void> {
    const dir = this.revisionDir(packageId, revision, kind);
    const backup = this.rewriteBackupDir(dir);
    await this.removeDirectory(this.rewriteDir(dir));
    if (!existsSync(backup)) return;
    await this.removeDirectory(dir);
    await rename(backup, dir);
  }

  /** Drops the backups: the database now describes the rewritten bytes. */
  private async finishRewrites(
    targets: readonly RevisionTarget[],
  ): Promise<void> {
    for (const target of targets) {
      await this.finishRewrite(
        target.packageId,
        target.revision,
        target.kind,
      ).catch((cause) =>
        this.logger.warn(`rewrite cleanup failed: ${errorMessage(cause)}`),
      );
    }
  }

  /** Puts the originals back, newest target first. */
  private async abortRewrites(
    targets: readonly RevisionTarget[],
  ): Promise<void> {
    for (const target of [...targets].reverse()) {
      await this.abortRewrite(
        target.packageId,
        target.revision,
        target.kind,
      ).catch((cause) =>
        this.logger.warn(`rewrite abort failed: ${errorMessage(cause)}`),
      );
    }
  }

  private revisionDir(
    packageId: number,
    revision: number,
    kind: RevisionKind,
  ): string {
    return kind === 'published'
      ? this.publishedRevisionDir(packageId, revision)
      : this.draftRevisionDir(packageId, revision);
  }

  private rewriteDir(dir: string): string {
    return `${dir}.rewrite`;
  }

  private rewriteBackupDir(dir: string): string {
    return `${dir}.old`;
  }

  /**
   * Repairs what an interrupted rewrite left behind: a leftover prepared tree
   * is useless, and a backup only has to come back when the live tree is gone
   * (the swap ran, the commit did not).
   */
  private async recoverRewrite(dir: string): Promise<void> {
    await this.removeDirectory(this.rewriteDir(dir));
    const backup = this.rewriteBackupDir(dir);
    if (!existsSync(backup)) return;
    if (existsSync(dir)) {
      await this.removeDirectory(backup);
      return;
    }
    await rename(backup, dir);
  }

  private async copyDirectory(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    for (const filepath of await this.listFilesRecursive(from)) {
      const target = resolvePackagePath(to, filepath);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(resolvePackagePath(from, filepath), target);
    }
  }

  /**
   * Removes every file the platform stored for a package: draft and published
   * revisions, dependency pins and every runtime artifact of every room.
   *
   * The database row is deleted by the caller; without this the package
   * directory (`revisions/<n>`, `runtime/v2/...`, plus orphaned legacy
   * `runtime/v1/...`) would stay on disk forever.
   */
  async removePackage(packageId: number): Promise<void> {
    await this.removeDirectory(this.packageRootDir(packageId));
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
