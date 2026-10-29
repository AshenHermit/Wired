import { PackageRevision } from "@wired-io/shared";
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
  onProgress?: (current: number, total: number) => void
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
      file.contents
    );
    if (saved.size !== file.entry.size || saved.sha256 !== file.entry.sha256) {
      throw new Error(
        `File ${file.entry.filepath} was stored with different contents: sha256 mismatch`
      );
    }
    onProgress?.(index + 1, collected.length);
  }

  const revision = await publishPackageRevision(packageId, draft.revision);
  return { revision, uploaded: collected.length };
}

/**
 * Downloads the latest published revision of a package over HTTP and writes it
 * into the editor file system. Files that are absent from the manifest are
 * removed from the package directory only.
 */
export async function syncPackageRevision(
  packageId: number,
  files: PackageFileSystem,
  onProgress?: ApplyPackageRevisionOptions["onProgress"]
): Promise<{ written: string[]; deleted: string[] }> {
  const manifest = await getPackageManifest(packageId);

  return applyPackageRevision({
    files,
    manifest,
    download: async (filepath) =>
      new Uint8Array(
        await getRevisionFile(manifest.packageId, manifest.revision, filepath)
      ),
    onProgress,
  });
}
