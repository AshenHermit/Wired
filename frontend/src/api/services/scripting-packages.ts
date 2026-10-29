import {
  CreatePackageRevisionPayload,
  CreateScriptingPackagePayload,
  PackageFileEntry,
  PackageManifest,
  PackageRevision,
  ScriptingPackage,
  UpdateScriptingPackagePayload,
} from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";
import { uint8ArrayToFile } from "@/utils/file-utils";

export async function listScriptingPackages() {
  return apiClient.get<ScriptingPackage[], void>("scripting-packages");
}

export async function getScriptingPackage(id: number) {
  return apiClient.get<ScriptingPackage, void>(`scripting-packages/${id}`);
}

export async function createScriptingPackage(
  data: CreateScriptingPackagePayload
) {
  return apiClient.post<ScriptingPackage, CreateScriptingPackagePayload>(
    "scripting-packages",
    data
  );
}

export async function updateScriptingPackage(
  id: number,
  data: UpdateScriptingPackagePayload
) {
  return apiClient.patch<ScriptingPackage, UpdateScriptingPackagePayload>(
    `scripting-packages/${id}`,
    data
  );
}

export async function deleteScriptingPackage(id: number) {
  return apiClient.delete<void, void>(`scripting-packages/${id}`);
}

// --- Package revisions ------------------------------------------------------
// A revision is a set of files that is uploaded file by file and then
// published as an immutable snapshot served to the Godot server and clients.

export async function listPackageRevisions(packageId: number) {
  return apiClient.get<PackageRevision[], void>(
    `scripting-packages/${packageId}/revisions`
  );
}

export async function createPackageRevision(
  packageId: number,
  data: CreatePackageRevisionPayload
) {
  return apiClient.post<PackageRevision, CreatePackageRevisionPayload>(
    `scripting-packages/${packageId}/revisions`,
    data
  );
}

export async function uploadRevisionFile(
  packageId: number,
  revision: number,
  filepath: string,
  file: File
) {
  return apiClient.postFile<{ size: number; sha256: string }>(
    `scripting-packages/${packageId}/revisions/${revision}/files/${encodeFilePath(
      filepath
    )}`,
    file
  );
}

export async function uploadRevisionFileAsUint8Array(
  packageId: number,
  revision: number,
  entry: PackageFileEntry,
  contents: Uint8Array
) {
  return uploadRevisionFile(
    packageId,
    revision,
    entry.filepath,
    uint8ArrayToFile(contents, entry.filepath, "application/octet-stream")
  );
}

export async function publishPackageRevision(
  packageId: number,
  revision: number
) {
  return apiClient.post<PackageRevision, void>(
    `scripting-packages/${packageId}/revisions/${revision}/publish`
  );
}

export async function getPackageManifest(packageId: number) {
  return apiClient.get<PackageManifest, void>(
    `scripting-packages/${packageId}/manifest`
  );
}

export async function getRevisionManifest(packageId: number, revision: number) {
  return apiClient.get<PackageManifest, void>(
    `scripting-packages/${packageId}/revisions/${revision}/manifest`
  );
}

export async function getRevisionFile(
  packageId: number,
  revision: number,
  filepath: string
) {
  return apiClient.getFile<void>(
    `scripting-packages/${packageId}/revisions/${revision}/files/${encodeFilePath(
      filepath
    )}`
  );
}

/** Encodes every path segment, keeping the `/` separators meaningful. */
function encodeFilePath(filepath: string) {
  return filepath.split("/").map(encodeURIComponent).join("/");
}
