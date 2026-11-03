import { PackageFileEntry, PackageManifest } from "@wired-io/shared";
import { sha256Hex } from "@/utils/sha256";
import type { EditorBridgeClient } from "./editor-bridge";

/**
 * Typed access to the package files of the running Godot editor.
 *
 * The shell never touches the editor file system directly: every read and
 * write goes through the Wired editor plugin over the request/response bridge.
 * The plugin owns the directory swap (staging directory, rollback to the
 * previous directory) and filters editor metadata (`.uid`, `.import`, dot
 * paths), so this layer only validates package-relative paths and maps bridge
 * payloads into typed values.
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
 * Files the Godot editor generates next to package sources (`.gd.uid`,
 * `*.import`, `.godot/`). The plugin lists them deliberately (hidden files are
 * included) and filters them out of `snapshot`, `collect` and `replace`; this
 * predicate mirrors that rule for callers that show a path to the user or
 * decide what a package revision owns.
 */
export function isEditorMetadataPath(filepath: string): boolean {
  const segments = filepath.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return true;
  return filepath.endsWith(".uid") || filepath.endsWith(".import");
}

export const PACKAGES_DIR = "packages";

/**
 * Validates a package-relative path and returns it unchanged. Mirrors the
 * server-side and plugin-side rules: `/`-separated, no absolute paths, no
 * `.`/`..`, no empty segments. The plugin is the authority; this is the second
 * line of defense before a path is handed to the engine.
 */
export function assertRelativePackagePath(relativePath: string): string {
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
 * Editor folder names are package slugs: lowercase latin letters, digits and
 * underscores. Legacy packages created before slugs may still use a numeric
 * slug, which this pattern accepts; the server applies the stricter
 * new-package regex on creation. Deliberately laxer than
 * `PACKAGE_SLUG_PATTERN` in `@wired-io/shared`: this is a path-safety check on
 * existing directories, not an authoring rule.
 */
export const PACKAGE_DIR_SLUG_PATTERN = /^[a-z0-9_]{1,64}$/;

export function assertPackageSlug(slug: string): string {
  if (typeof slug !== "string" || !PACKAGE_DIR_SLUG_PATTERN.test(slug)) {
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
  ): Promise<{ written: string[]; deleted: string[] }>;
  deletePackage(slug: string): Promise<void>;
  renamePackage(from: string, to: string): Promise<string[]>;
  sync(): Promise<void>;
  packageDir(slug: string): string;
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

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_LOOKUP = (() => {
  const table = new Uint8Array(128);
  table.fill(255);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/**
 * Decodes the plugin's base64 payload directly into a byte buffer.
 *
 * Package files are binary (`import` caches, scenes, PNGs), so routing them
 * through `atob` — a JavaScript string with one code unit per byte — is both
 * wasteful and easy to get wrong for non-UTF-8 contents. The buffer path writes
 * every sextet into a preallocated `Uint8Array`; platforms that expose the
 * staged `Uint8Array.fromBase64` use it directly.
 */
function decodeBase64(contentsBase64: string): Uint8Array {
  const fromBase64 = (
    Uint8Array as unknown as {
      fromBase64?: (value: string) => Uint8Array;
    }
  ).fromBase64;
  if (typeof fromBase64 === "function") {
    return fromBase64(contentsBase64);
  }

  const clean = contentsBase64.replace(/[\s=]/g, "");
  const length = clean.length;
  const output = new Uint8Array(Math.floor((length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < length; index += 1) {
    const code = clean.charCodeAt(index);
    const value = code < BASE64_LOOKUP.length ? BASE64_LOOKUP[code] : 255;
    if (value === 255) {
      throw new GodotFsError(
        "Редактор вернул некорректный base64-файл пакета",
      );
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  return offset === output.length ? output : output.subarray(0, offset);
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

  const sync = async (): Promise<void> => {
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
      await sync();
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
     * reaches `sync`.
     */
    async replaceContents(slug, contents) {
      assertPackageSlug(slug);
      const staged = [...contents].map(([filepath, data]) => ({
        filepath: assertRelativePackagePath(filepath),
        data,
      }));

      // Read the write primitive before the plugin creates a staging directory:
      // an editor that was reset between the revision download and this write
      // must fail here, not after files were copied into an orphan staging dir.
      const engine = getEngine();
      if (!engine) {
        throw new GodotFsError(
          "Файловая система Godot-редактора ещё не готова: дождитесь загрузки проекта",
        );
      }

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
      }

      const result = await bridge.call<ReplacePayload>("replace", {
        packageSlug: slug,
      });
      await sync();
      return { written: result.written, deleted: result.deleted };
    },

    async deletePackage(slug) {
      assertPackageSlug(slug);
      await bridge.call("delete", { packageSlug: slug });
      await sync();
    },

    async renamePackage(from, to) {
      assertPackageSlug(from);
      assertPackageSlug(to);
      const { rewritten } = await bridge.call<{ rewritten: string[] }>(
        "rename",
        { packageSlug: from, newSlug: to },
      );
      await sync();
      return rewritten;
    },

    sync,
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

  return files.replaceContents(manifest.slug, verified);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
