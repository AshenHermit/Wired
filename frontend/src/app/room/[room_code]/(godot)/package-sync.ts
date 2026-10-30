import { PackageManifest, PackageRevision } from "@wired-io/shared";
import {
  createPackageRevision,
  getPackageManifest,
  getRevisionFile,
  publishPackageRevision,
  uploadRevisionFileAsUint8Array,
} from "@/api/services/scripting-packages";
import {
  PackageFileSystem,
  applyPackageRevision,
  type ApplyPackageRevisionOptions,
} from "./godot-packages-fs";

export type PublishPackageFilesResult = {
  revision: PackageRevision;
  uploaded: number;
};

/**
 * Publishes the current contents of the package directory of the Godot editor.
 *
 * The editor file system is the source of truth for drafts: files are read from
 * there, uploaded one by one to a new draft revision, checked against the size
 * and sha256 the server computed, and only then published. A failure at any
 * step leaves the previously published revision untouched.
 */
export async function publishPackageFiles(
  packageId: number,
  files: PackageFileSystem,
  onProgress?: (current: number, total: number) => void,
): Promise<PublishPackageFilesResult> {
  const collected = await files.collectFiles(packageId);
  if (collected.length === 0) {
    throw new Error(`Package ${packageId} has no files to publish`);
  }

  const draft = await createPackageRevision(packageId, {
    files: collected.map((file) => file.entry),
  });

  onProgress?.(0, collected.length);
  for (const [index, file] of collected.entries()) {
    const saved = await uploadRevisionFileAsUint8Array(
      packageId,
      draft.revision,
      file.entry,
      file.contents,
    );
    if (saved.size !== file.entry.size || saved.sha256 !== file.entry.sha256) {
      throw new Error(
        `File ${file.entry.filepath} was stored with different contents: sha256 mismatch`,
      );
    }
    onProgress?.(index + 1, collected.length);
  }

  const revision = await publishPackageRevision(packageId, draft.revision);
  return { revision, uploaded: collected.length };
}

/** The published revision last applied to this editor, with its file hashes. */
export type PackageBaseline = {
  revision: number;
  files: Record<string, string>;
};

export type PackageConflictReason = "modified" | "deleted" | "untracked";

export type PackageConflict = {
  filepath: string;
  reason: PackageConflictReason;
  localSha256: string | null;
  publishedSha256: string | null;
};

export type PackageSyncPlan = {
  status: "apply" | "up-to-date" | "conflict";
  conflicts: PackageConflict[];
};

const lowerCaseHashes = (
  files: Record<string, string>,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [filepath, hash] of Object.entries(files)) {
    result[filepath] = hash.toLowerCase();
  }
  return result;
};

/**
 * Decides how a published revision meets the editor file system.
 *
 * A local file is replaced only when it still matches the revision this editor
 * last applied. Local edits and untracked drafts are reported as conflicts so
 * the user can choose between keeping them and replacing them with the
 * published revision; nothing is overwritten silently.
 */
export function planPackageSync(
  local: Record<string, string>,
  manifest: PackageManifest,
  baseline: PackageBaseline | null,
): PackageSyncPlan {
  const localHashes = lowerCaseHashes(local);
  const published = new Map(
    manifest.files.map((file) => [file.filepath, file.sha256.toLowerCase()]),
  );
  const localPaths = Object.keys(localHashes);

  // No baseline and no local files: a fresh editor simply receives the
  // published revision.
  if (!baseline && localPaths.length === 0) {
    return { status: "apply", conflicts: [] };
  }

  if (!baseline || baseline.revision === manifest.revision) {
    const conflicts: PackageConflict[] = [];
    const paths = new Set([...localPaths, ...published.keys()]);
    for (const filepath of [...paths].sort()) {
      const localHash = localHashes[filepath] ?? null;
      const publishedHash = published.get(filepath) ?? null;
      if (localHash === publishedHash) continue;
      if (publishedHash === null) {
        conflicts.push({
          filepath,
          reason: "untracked",
          localSha256: localHash,
          publishedSha256: null,
        });
      } else if (localHash === null) {
        conflicts.push({
          filepath,
          reason: "deleted",
          localSha256: null,
          publishedSha256: publishedHash,
        });
      } else {
        conflicts.push({
          filepath,
          reason: "modified",
          localSha256: localHash,
          publishedSha256: publishedHash,
        });
      }
    }
    return conflicts.length > 0
      ? { status: "conflict", conflicts }
      : { status: "up-to-date", conflicts: [] };
  }

  const baselineFiles = lowerCaseHashes(baseline.files);
  const conflicts: PackageConflict[] = [];

  // Files that the new revision changes: overwrite only untouched local copies.
  for (const [filepath, publishedHash] of published) {
    const localHash = localHashes[filepath];
    if (localHash === undefined || localHash === publishedHash) continue;
    const baseHash = baselineFiles[filepath];
    if (baseHash !== undefined && localHash === baseHash) continue;
    conflicts.push({
      filepath,
      reason: "modified",
      localSha256: localHash,
      publishedSha256: publishedHash,
    });
  }

  // Files that the new revision drops: deleting an edited or untracked local
  // file would lose work.
  for (const filepath of localPaths) {
    if (published.has(filepath)) continue;
    const localHash = localHashes[filepath];
    const baseHash = baselineFiles[filepath];
    if (baseHash !== undefined && localHash === baseHash) continue;
    conflicts.push({
      filepath,
      reason: baseHash === undefined ? "untracked" : "modified",
      localSha256: localHash,
      publishedSha256: null,
    });
  }

  return conflicts.length > 0
    ? { status: "conflict", conflicts }
    : { status: "apply", conflicts: [] };
}

export type ReconcilePackageResult =
  | {
      status: "up-to-date";
      packageId: number;
      revision: number;
      files: Record<string, string>;
    }
  | {
      status: "applied";
      packageId: number;
      revision: number;
      written: string[];
      deleted: string[];
      files: Record<string, string>;
    }
  | {
      status: "conflict";
      packageId: number;
      revision: number;
      conflicts: PackageConflict[];
    };

/**
 * Downloads the latest published revision and, when it is safe, applies it to
 * the editor file system. The caller persists the returned `files` as the new
 * baseline.
 */
export async function reconcilePackageRevision(
  packageId: number,
  files: PackageFileSystem,
  baseline: PackageBaseline | null,
  options: { force?: boolean; onProgress?: ApplyPackageRevisionOptions["onProgress"] } = {},
): Promise<ReconcilePackageResult> {
  const manifest = await getPackageManifest(packageId);
  const local = await files.snapshot(packageId);
  const plan = options.force
    ? ({ status: "apply", conflicts: [] } as PackageSyncPlan)
    : planPackageSync(local, manifest, baseline);

  const publishedHashes: Record<string, string> = {};
  for (const file of manifest.files) {
    publishedHashes[file.filepath] = file.sha256.toLowerCase();
  }

  if (plan.status === "conflict") {
    return {
      status: "conflict",
      packageId,
      revision: manifest.revision,
      conflicts: plan.conflicts,
    };
  }

  if (plan.status === "up-to-date") {
    return {
      status: "up-to-date",
      packageId,
      revision: manifest.revision,
      files: publishedHashes,
    };
  }

  const { written, deleted } = await applyPackageRevision({
    files,
    manifest,
    download: async (filepath) =>
      new Uint8Array(
        await getRevisionFile(manifest.packageId, manifest.revision, filepath),
      ),
    onProgress: options.onProgress,
  });

  return {
    status: "applied",
    packageId,
    revision: manifest.revision,
    written,
    deleted,
    files: publishedHashes,
  };
}

/**
 * Forces the latest published revision into the editor file system. Used by the
 * explicit "replace local files" action of the conflict prompt, never during
 * automatic synchronization.
 */
export async function syncPackageRevision(
  packageId: number,
  files: PackageFileSystem,
  onProgress?: ApplyPackageRevisionOptions["onProgress"],
): Promise<{ written: string[]; deleted: string[] }> {
  const result = await reconcilePackageRevision(packageId, files, null, {
    force: true,
    onProgress,
  });
  if (result.status !== "applied") {
    throw new Error(`Package ${packageId} was not applied`);
  }
  return { written: result.written, deleted: result.deleted };
}
