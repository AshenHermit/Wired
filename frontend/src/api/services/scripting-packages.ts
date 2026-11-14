import {
  CreatePackageRevisionPayload,
  CreateScriptingPackagePayload,
  PackageFileEntry,
  PackageManifest,
  PackageRevision,
  PackageRevisionDraft,
  PackageSlugAvailability,
  ScriptingPackage,
  UpdatePackageAccessPayload,
  UpdateScriptingPackagePayload,
  WorkshopListing,
  WorkshopPackageMetadata,
  WorkshopPackageSummary,
  WorkshopPublishResult,
  WorkshopTagListing,
} from "@wired-io/shared";
import { apiClient } from "../api-client/api-client";
import { uint8ArrayToFile } from "@/utils/file-utils";

export function createScriptingPackage(
  data: CreateScriptingPackagePayload
) {
  return apiClient.post<ScriptingPackage>(
    "scripting-packages",
    data
  );
}

/**
 * Reads one package by id, including its description and tags. The publish
 * dialog uses it to prefill a new workshop record from the room package.
 */
export function getScriptingPackage(id: number) {
  return apiClient.get<ScriptingPackage>(`scripting-packages/${id}`);
}

export function updateScriptingPackage(
  id: number,
  data: UpdateScriptingPackagePayload
) {
  return apiClient.patch<ScriptingPackage>(
    `scripting-packages/${id}`,
    data
  );
}

export function deleteScriptingPackage(id: number) {
  return apiClient.delete<void>(`scripting-packages/${id}`);
}

export function updatePackageAccess(
  id: number,
  data: UpdatePackageAccessPayload
) {
  return apiClient.patch<ScriptingPackage>(
    `scripting-packages/${id}/access`,
    data
  );
}

/**
 * Asks the backend whether a new package may use this slug.
 * Room slugs are only unique inside their room, so the global workshop scope is
 * reported separately and always checked by the caller.
 * `excludeId` keeps a renamed package from reporting its own slug as taken.
 */
export function checkPackageSlugAvailability(
  slug: string,
  roomId?: number,
  excludeId?: number
): Promise<PackageSlugAvailability> {
  return apiClient.get<PackageSlugAvailability>("scripting-packages/slug-availability", {
    slug,
    ...(roomId === undefined ? {} : { roomId }),
    ...(excludeId === undefined ? {} : { excludeId }),
  });
}

// --- Workshop ---------------------------------------------------------------
// The workshop is the public catalogue of packages published from rooms. Copies
// (fork, add to room) run on the server and never mutate the source package.

export function listWorkshopPackages(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<WorkshopListing> {
  return apiClient.get<WorkshopListing>("scripting-packages/workshop", params);
}

export function listWorkshopTags(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<WorkshopTagListing> {
  return apiClient.get<WorkshopTagListing>("scripting-packages/workshop/tags", params);
}

export async function lookupWorkshopPackage(
  slug: string
): Promise<WorkshopPackageSummary | null> {
  const result = await apiClient.get<{ package: WorkshopPackageSummary | null }>("scripting-packages/workshop/lookup", { slug });
  return result.package;
}

export function publishPackageToWorkshop(
  id: number,
  metadata: WorkshopPackageMetadata
): Promise<WorkshopPublishResult> {
  return apiClient.post<WorkshopPublishResult>(
    `scripting-packages/${id}/workshop`,
    metadata
  );
}

export function forkPackageToWorkshop(
  id: number,
  slug: string
): Promise<ScriptingPackage> {
  return apiClient.post<ScriptingPackage>(
    `scripting-packages/${id}/workshop-fork`,
    { slug }
  );
}

export function copyWorkshopPackageToRoom(
  id: number,
  roomId: number
): Promise<ScriptingPackage> {
  return apiClient.post<ScriptingPackage>(
    `scripting-packages/${id}/room-copy`,
    { roomId }
  );
}

// --- Package revisions ------------------------------------------------------
// A revision is a set of files that is uploaded file by file and then
// published as an immutable snapshot served to the Godot server and clients.

export function createPackageRevision(
  packageId: number,
  data: CreatePackageRevisionPayload
) {
  return apiClient.post<PackageRevisionDraft>(
    `scripting-packages/${packageId}/revisions`,
    data
  );
}

export function uploadRevisionFile(
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

export function uploadRevisionFileAsUint8Array(
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

export function publishPackageRevision(
  packageId: number,
  revision: number
) {
  return apiClient.post<PackageRevision>(
    `scripting-packages/${packageId}/revisions/${revision}/publish`
  );
}

export function getPackageManifest(packageId: number) {
  return apiClient.get<PackageManifest>(
    `scripting-packages/${packageId}/manifest`
  );
}

export function getRevisionFile(
  packageId: number,
  revision: number,
  filepath: string
) {
  return apiClient.getFile(
    `scripting-packages/${packageId}/revisions/${revision}/files/${encodeFilePath(
      filepath
    )}`
  );
}

/** Encodes every path segment, keeping the `/` separators meaningful. */
function encodeFilePath(filepath: string) {
  return filepath.split("/").map(encodeURIComponent).join("/");
}
