import { PackageFileEntry, PackageManifest } from "@wired-io/shared";
import { sha256Hex } from "@/utils/sha256";

/**
 * Typed access to the Godot editor file system.
 *
 * The custom editor build exposes the Emscripten file system of the running
 * editor instance (`instance.editor.rtenv.FS`). Writing there changes the
 * project inside the browser sandbox only: it is a draft source for package
 * files and never touches the sources on the server disk.
 *
 * Every path handled here is relative to the managed package directory
 * (`<project>/packages/<packageId>`), so a package revision can never read or
 * overwrite files outside its own directory.
 */

export class GodotFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GodotFsError";
  }
}

/** The subset of the Emscripten FS used by the package bridge. */
export type EmscriptenFs = {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  mkdirTree(path: string): void;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  unlink(path: string): void;
  rmdir?(path: string): void;
  syncfs?(populate: boolean, callback: (error?: unknown) => void): void;
};

export const PACKAGES_DIR = "packages";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

function isDirectory(fs: EmscriptenFs, path: string): boolean {
  try {
    return (fs.stat(path).mode & S_IFMT) === S_IFDIR;
  } catch {
    return false;
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/**
 * Validates a package-relative path and returns it unchanged. Mirrors the
 * server-side rules: `/`-separated, no absolute paths, no `.`/`..`, no empty
 * segments. The server is the authority; this is the second line of defense
 * before touching the editor file system.
 */
export function assertRelativePackagePath(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new GodotFsError("Package file path must be a non-empty string");
  }
  if (relativePath.startsWith("/") || relativePath.includes("\\")) {
    throw new GodotFsError(
      `Package file path must be relative: ${relativePath}`
    );
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new GodotFsError(
        `Package file path must not contain empty, "." or ".." segments: ${relativePath}`
      );
    }
  }
  return segments.join("/");
}

export type CollectedPackageFile = {
  entry: PackageFileEntry;
  contents: Uint8Array;
};

export class PackageFileSystem {
  constructor(
    private readonly fs: EmscriptenFs,
    private readonly projectRoot: string
  ) {
    if (!fs) {
      throw new GodotFsError(
        "Файловая система Godot-редактора ещё не готова: дождитесь загрузки проекта"
      );
    }
  }

  get packagesRoot(): string {
    return `${this.projectRoot}/${PACKAGES_DIR}`;
  }

  packageDir(packageId: number): string {
    if (!Number.isInteger(packageId) || packageId <= 0) {
      throw new GodotFsError(`Invalid package id: ${packageId}`);
    }
    return `${this.packagesRoot}/${packageId}`;
  }

  resolve(packageId: number, filepath: string): string {
    return `${this.packageDir(packageId)}/${assertRelativePackagePath(filepath)}`;
  }

  async listFiles(packageId: number): Promise<string[]> {
    return this.walk(packageId, "");
  }

  hasFile(packageId: number, filepath: string): boolean {
    return !isDirectory(this.fs, this.resolve(packageId, filepath));
  }

  readFile(packageId: number, filepath: string): Uint8Array {
    const path = this.resolve(packageId, filepath);
    try {
      return this.fs.readFile(path);
    } catch {
      throw new GodotFsError(
        `Package ${packageId}: file ${filepath} does not exist in the editor file system`
      );
    }
  }

  writeFile(packageId: number, filepath: string, contents: Uint8Array): void {
    const path = this.resolve(packageId, filepath);
    try {
      this.fs.mkdirTree(dirname(path));
      this.fs.writeFile(path, contents);
    } catch (error) {
      throw new GodotFsError(
        `Package ${packageId}: cannot write ${filepath}: ${errorMessage(error)}`
      );
    }
  }

  deleteFile(packageId: number, filepath: string): void {
    this.fs.unlink(this.resolve(packageId, filepath));
  }

  /**
   * Deletes every package file that is not in `keepPaths`. Only the managed
   * package directory is touched, so files of other packages and the project
   * itself are never affected.
   */
  async prune(packageId: number, keepPaths: string[]): Promise<string[]> {
    const keep = new Set(keepPaths
      .map((path) => assertRelativePackagePath(path)));
    const existing = await this.listFiles(packageId);
    const stale = existing.filter((path) => !keep.has(path));
    for (const path of stale) {
      this.deleteFile(packageId, path);
    }
    this.removeEmptyDirectories(packageId);
    return stale;
  }

  async deletePackage(packageId: number): Promise<void> {
    await this.prune(packageId, []);
    const dir = this.packageDir(packageId);
    if (this.fs.rmdir && isDirectory(this.fs, dir)) {
      this.fs.rmdir(dir);
    }
  }

  /** Reads every package file together with its size and sha256. */
  async collectFiles(packageId: number): Promise<CollectedPackageFile[]> {
    const filepaths = await this.listFiles(packageId);
    const collected: CollectedPackageFile[] = [];
    for (const filepath of filepaths) {
      const contents = this.readFile(packageId, filepath);
      collected.push({
        entry: {
          filepath,
          size: contents.byteLength,
          sha256: await sha256Hex(contents),
        },
        contents,
      });
    }
    return collected;
  }

  /**
   * Persists the in-memory file system to IndexedDB, so written package files
   * survive an editor or page restart.
   */
  async sync(): Promise<void> {
    const syncfs = this.fs.syncfs;
    if (!syncfs) return;
    await new Promise<void>((resolve, reject) => {
      syncfs.call(this.fs, false, (error) => {
        if (error) {
          reject(
            new GodotFsError(
              `Cannot persist the editor file system: ${errorMessage(error)}`
            )
          );
          return;
        }
        resolve();
      });
    });
  }

  private walk(packageId: number, prefix: string): string[] {
    const root = this.packageDir(packageId);
    const dir = prefix ? `${root}/${prefix}` : root;
    if (!isDirectory(this.fs, dir)) return [];

    const files: string[] = [];
    for (const name of this.fs.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (isDirectory(this.fs, `${root}/${relative}`)) {
        files.push(...this.walk(packageId, relative));
      } else {
        files.push(relative);
      }
    }
    return files.sort();
  }

  private removeEmptyDirectories(packageId: number): void {
    const root = this.packageDir(packageId);
    const visit = (dir: string) => {
      for (const name of this.fs.readdir(dir)) {
        if (name === "." || name === "..") continue;
        const path = `${dir}/${name}`;
        if (isDirectory(this.fs, path)) visit(path);
      }
      if (dir !== root && this.fs.readdir(dir).length === 0) {
        this.fs.rmdir?.(dir);
      }
    };
    if (isDirectory(this.fs, root)) visit(root);
  }
}

export function createPackageFileSystem(
  instance: { editor?: unknown; rootPath?: string; projectInfo?: { name: string } | null }
): PackageFileSystem {
  const fs = (instance?.editor as { rtenv?: { FS?: EmscriptenFs } } | undefined)
    ?.rtenv?.FS;
  if (!fs) {
    throw new GodotFsError(
      "Файловая система Godot-редактора ещё не готова: дождитесь загрузки проекта"
    );
  }
  if (!instance.rootPath || !instance.projectInfo?.name) {
    throw new GodotFsError(
      "Проект Godot ещё не загружен в редактор: пакеты недоступны"
    );
  }
  return new PackageFileSystem(
    fs,
    `${instance.rootPath}/${instance.projectInfo.name}`
  );
}

export type ApplyPackageRevisionOptions = {
  files: PackageFileSystem;
  manifest: PackageManifest;
  download: (filepath: string) => Promise<Uint8Array>;
  onProgress?: (current: number, total: number) => void;
};

/**
 * Downloads and applies a published package revision.
 *
 * Every file is downloaded and verified in memory first: if any file is
 * missing, truncated or has a wrong hash, nothing is written and the previous
 * revision stays intact. Only after the whole manifest verifies are the files
 * written, stale files inside the package directory pruned, and the result
 * persisted.
 */
export async function applyPackageRevision({
  files,
  manifest,
  download,
  onProgress,
}: ApplyPackageRevisionOptions): Promise<{
  written: string[];
  deleted: string[];
}> {
  const total = manifest.files.length;
  const verified = new Map<string, Uint8Array>();
  onProgress?.(0, total);

  for (const [index, file] of manifest.files.entries()) {
    const contents = await download(file.filepath);
    if (contents.byteLength !== file.size) {
      throw new GodotFsError(
        `Package ${manifest.packageId}: size mismatch for ${file.filepath} (expected ${file.size} bytes, got ${contents.byteLength})`
      );
    }
    const hash = await sha256Hex(contents);
    if (hash !== file.sha256.toLowerCase()) {
      throw new GodotFsError(
        `Package ${manifest.packageId}: sha256 mismatch for ${file.filepath}`
      );
    }
    verified.set(assertRelativePackagePath(file.filepath), contents);
    onProgress?.(index + 1, total);
  }

  const written: string[] = [];
  for (const [filepath, contents] of verified) {
    files.writeFile(manifest.packageId, filepath, contents);
    written.push(filepath);
  }

  const deleted = await files.prune(
    manifest.packageId,
    manifest.files.map((file) => file.filepath)
  );
  await files.sync();

  return { written: written.sort(), deleted };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
