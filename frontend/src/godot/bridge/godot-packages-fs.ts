import { PackageFileEntry, PackageManifest } from "@wired-io/shared";
import {
  emitPackageProgress,
  packagePercent,
  type PackageProgressEvent,
} from "@/lib/editorBridgeEvents";
import { sha256Hex } from "@/utils/sha256";
import { errorMessage } from "@/utils/errors";
import type { EditorBridgeClient } from "./editor-bridge";

/**
 * Typed access to the package files of the running Godot editor.
 *
 * The shell never touches the editor file system directly: every read and
 * write goes through the Wired editor plugin over the request/response bridge.
 * The plugin owns the directory swap (staging directory, rollback to the
 * previous directory) and filters editor metadata (`.uid`, dot paths), so this
 * layer only validates package-relative paths and maps bridge payloads into
 * typed values. Import sidecars (`*.import`) are package content, not metadata.
 *
 * Every path handled here is relative to the managed package directory
 * (`<project>/packages/<slug>`), so a package revision can never read or
 * overwrite files outside its own directory.
 */

export class GodotFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GodotFsError";
  }
}

/**
 * Files the Godot editor owns inside a package (`.gd.uid`, `.godot/`, any
 * dot-prefixed segment). The plugin lists them deliberately (hidden files are
 * included) and filters them out of `snapshot`, `collect` and `replace`; this
 * predicate mirrors that rule for callers that show a path to the user or
 * decide what a package revision owns. `*.import` is package content: it is the
 * portable import preset of its source.
 */
export function isEditorMetadataPath(filepath: string): boolean {
  const segments = filepath.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return true;
  return filepath.endsWith(".uid");
}

export const PACKAGES_DIR = "packages";

/**
 * Validates a package-relative path and returns it unchanged. Mirrors the
 * server-side and plugin-side rules: `/`-separated, no absolute paths, no
 * `.`/`..`, no empty segments. The plugin is the authority; this is the second
 * line of defense before a path is handed to the engine.
 */
export function assertRelativePackagePath(relativePath: string): string {
  // Filepaths reach this from the plugin's `collect` payload, where the
  // annotation is a claim about the wire rather than a guarantee, so the raw
  // value is checked before the path rules below dereference it.
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new GodotFsError("Package file path must be a non-empty string");
  }
  if (relativePath.startsWith("/") || relativePath.includes("\\")) {
    throw new GodotFsError(
      `Package file path must be relative: ${relativePath}`,
    );
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new GodotFsError(
        `Package file path must not contain empty, "." or ".." segments: ${relativePath}`,
      );
    }
  }
  return segments.join("/");
}

export type CollectedPackageFile = {
  entry: PackageFileEntry;
  contents: Uint8Array;
};

/**
 * Optional reporting for a directory swap. The file system stays free of
 * progress UI: it only says how many bytes reached the staging directory, and
 * the caller decides what to show.
 */
export type ReplaceContentsOptions = {
  onFileWritten?: (writtenBytes: number, totalBytes: number) => void;
};

/**
 * Editor folder names are package slugs: lowercase latin letters, digits and
 * underscores. Legacy packages created before slugs may still use a numeric
 * slug, which this pattern accepts; the server applies the stricter
 * new-package regex on creation. Deliberately laxer than
 * `PACKAGE_SLUG_PATTERN` in `@wired-io/shared`: this is a path-safety check on
 * existing directories, not an authoring rule.
 */
export const PACKAGE_DIR_SLUG_PATTERN = /^[a-z0-9_]{1,64}$/;

export function assertPackageSlug(slug: string): string {
  if (!PACKAGE_DIR_SLUG_PATTERN.test(slug)) {
    throw new GodotFsError(`Недопустимый slug пакета: ${slug}`);
  }
  return slug;
}

/** The editor instance: only the write primitive packages need. */
export type PackageEngine = {
  copyToFS(path: string, data: Uint8Array): void;
};

export type PackageFileSystem = {
  exists(slug: string): Promise<boolean>;
  createPackageDir(slug: string): Promise<void>;
  snapshot(slug: string): Promise<Record<string, string>>;
  collectFiles(slug: string): Promise<CollectedPackageFile[]>;
  replaceContents(
    slug: string,
    contents: Map<string, Uint8Array>,
    options?: ReplaceContentsOptions,
  ): Promise<{ written: string[]; deleted: string[] }>;
  deletePackage(slug: string): Promise<void>;
  renamePackage(from: string, to: string): Promise<string[]>;
  /**
   * Flushes the editor's in-memory writes to its persistent file system, so the
   * engine sees them. Doubles as the probe that proves the bridge is alive.
   */
  flushFilesystem(): Promise<void>;
  packageDir(slug: string): string;
  /**
   * Abandons in-flight bridge calls. Called when the editor instance this file
   * system talks to is replaced, so a pending answer cannot land in its
   * successor's file system.
   */
  dispose(): void;
};

/** Payloads the plugin answers with; `contents_base64` is its wire name. */
type ExistsPayload = { exists: boolean };
type SnapshotPayload = { files: Record<string, string> };
type CollectPayload = { files: CollectedFilePayload[] };
type CollectedFilePayload = {
  filepath: string;
  size: number;
  sha256: string;
  contents_base64: string;
};
type PrepareReplacePayload = { staging_path: string };
type ReplacePayload = { written: string[]; deleted: string[] };

/**
 * The plugin answers with `ProjectSettings.globalize_path(...)`: an absolute
 * path inside the engine file system. An empty or relative answer, or one that
 * does not end with `<packages>/.<slug>.staging`, would let `copyToFS` write
 * outside the package tree, so it is rejected before the first write and
 * before the swap.
 */
function assertStagingPath(stagingPath: string, slug: string): string {
  const expectedSuffix = `/${PACKAGES_DIR}/.${slug}.staging`;
  if (
    typeof stagingPath !== "string" ||
    stagingPath.length === 0 ||
    !stagingPath.startsWith("/") ||
    !stagingPath.endsWith(expectedSuffix)
  ) {
    throw new GodotFsError("Редактор вернул некорректный каталог staging");
  }
  return stagingPath;
}

/**
 * Decodes the plugin's base64 payload into bytes.
 *
 * `atob` runs the standard forgiving decode (it strips the line wrapping the
 * plugin may add) and maps each code unit to one byte, which is exactly the
 * payload's encoding; the byte buffer is built without ever materialising the
 * value as text.
 */
function decodeBase64(contentsBase64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(contentsBase64);
  } catch {
    throw new GodotFsError("Редактор вернул некорректный base64-файл пакета");
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Creates the package file system of the running editor.
 *
 * `getEngine` is read on every replacement instead of being captured once: the
 * editor instance is recreated when the page restarts the engine, and writes
 * must reach the live one. An engine that is gone must be reported as a
 * `GodotFsError` by the getter itself, never as a raw `TypeError`.
 */
export function createPackageFileSystem({
  bridge,
  getEngine,
  projectRoot,
}: {
  bridge: EditorBridgeClient;
  getEngine: () => PackageEngine;
  projectRoot: string;
}): PackageFileSystem {
  if (!projectRoot) {
    throw new GodotFsError(
      "Проект Godot ещё не загружен в редактор: пакеты недоступны",
    );
  }

  const packageDir = (slug: string): string =>
    `${projectRoot}/${PACKAGES_DIR}/${assertPackageSlug(slug)}`;

  const flushFilesystem = async (): Promise<void> => {
    await bridge.call("sync", {});
  };

  return {
    packageDir,

    async exists(slug) {
      assertPackageSlug(slug);
      const { exists: result } = await bridge.call<ExistsPayload>("exists", {
        packageSlug: slug,
      });
      return result;
    },

    /**
     * Creates the package directory without touching any other package. A newly
     * created room package starts as an empty directory the user can fill in.
     */
    async createPackageDir(slug) {
      assertPackageSlug(slug);
      await bridge.call("createDir", { packageSlug: slug });
      await flushFilesystem();
    },

    /** Hashes of the source files currently in the package directory. */
    async snapshot(slug) {
      assertPackageSlug(slug);
      const { files } = await bridge.call<SnapshotPayload>("snapshot", {
        packageSlug: slug,
      });
      return files;
    },

    /** Reads every package file the plugin collected, with size and sha256. */
    async collectFiles(slug) {
      assertPackageSlug(slug);
      const { files } = await bridge.call<CollectPayload>("collect", {
        packageSlug: slug,
      });
      return files.map((file) => {
        const contentsBase64 = file.contents_base64;
        return {
          entry: {
            filepath: assertRelativePackagePath(file.filepath),
            size: file.size,
            sha256: file.sha256,
          },
          contents: decodeBase64(contentsBase64),
        };
      });
    },

    /**
     * Replaces the whole package directory in one swap.
     *
     * The plugin prepares a staging directory, the revision is copied there,
     * and only then does the plugin rename it into place. A failure while
     * staging or swapping leaves the previous revision untouched and never
     * reaches `flushFilesystem`.
     */
    async replaceContents(slug, contents, options = {}) {
      assertPackageSlug(slug);
      const staged = [...contents].map(([filepath, data]) => ({
        filepath: assertRelativePackagePath(filepath),
        data,
      }));
      const totalBytes = staged.reduce(
        (sum, file) => sum + file.data.byteLength,
        0,
      );
      let writtenBytes = 0;

      // Read the write primitive before the plugin creates a staging directory:
      // an editor that was reset between the revision download and this write
      // must fail here, not after files were copied into an orphan staging dir.
      // A gone engine is reported by the getter itself, never as a TypeError.
      const engine = getEngine();

      const { staging_path: stagingPath } =
        await bridge.call<PrepareReplacePayload>("prepareReplace", {
          packageSlug: slug,
        });
      assertStagingPath(stagingPath, slug);

      for (const { filepath, data } of staged) {
        try {
          engine.copyToFS(`${stagingPath}/${filepath}`, data);
        } catch (error) {
          throw new GodotFsError(
            `Package ${slug}: cannot stage ${filepath}: ${errorMessage(error)}`,
          );
        }
        writtenBytes += data.byteLength;
        options.onFileWritten?.(writtenBytes, totalBytes);
      }

      const result = await bridge.call<ReplacePayload>("replace", {
        packageSlug: slug,
      });
      await flushFilesystem();
      return { written: result.written, deleted: result.deleted };
    },

    async deletePackage(slug) {
      assertPackageSlug(slug);
      await bridge.call("delete", { packageSlug: slug });
      await flushFilesystem();
    },

    async renamePackage(from, to) {
      assertPackageSlug(from);
      assertPackageSlug(to);
      const { rewritten } = await bridge.call<{ rewritten: string[] }>(
        "rename",
        { packageSlug: from, newSlug: to },
      );
      await flushFilesystem();
      return rewritten;
    },

    flushFilesystem,

    dispose() {
      bridge.dispose();
    },
  };
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
 * written; `replaceContents` swaps the directory and persists the result.
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

  // The bridge event channel announces the transfer, advances once per written
  // file and terminates with the final state. A revision can fail before
  // anything is written (a missing, truncated or mis-hashed download), so the
  // whole apply is reported, not just the directory swap.
  const report = (
    percent: number,
    status: PackageProgressEvent["status"],
    failure?: string,
  ): void => {
    emitPackageProgress({
      packageId: String(manifest.packageId),
      name: manifest.name,
      percent,
      status,
      ...(failure === undefined ? {} : { errorMessage: failure }),
    });
  };

  let percent = 0;
  try {
    report(percent, "loading");
    onProgress?.(0, total);

    for (const [index, file] of manifest.files.entries()) {
      const contents = await download(file.filepath);
      if (contents.byteLength !== file.size) {
        throw new GodotFsError(
          `Package ${manifest.packageId}: size mismatch for ${file.filepath} (expected ${file.size} bytes, got ${contents.byteLength})`,
        );
      }
      const hash = await sha256Hex(contents);
      if (hash !== file.sha256.toLowerCase()) {
        throw new GodotFsError(
          `Package ${manifest.packageId}: sha256 mismatch for ${file.filepath}`,
        );
      }
      verified.set(assertRelativePackagePath(file.filepath), contents);
      onProgress?.(index + 1, total);
    }

    const result = await files.replaceContents(manifest.slug, verified, {
      onFileWritten: (writtenBytes, totalBytes) => {
        percent = packagePercent(writtenBytes, totalBytes);
        report(percent, "loading");
      },
    });
    report(100, "complete");
    return result;
  } catch (error) {
    report(percent, "error", errorMessage(error));
    throw error;
  }
}
