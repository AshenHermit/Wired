import {
  CreatePackageRevisionPayload,
  CreateScriptingPackagePayload,
  PackageFileEntry,
  PackageManifest,
  PackageRevision,
  ScriptingPackage,
  UpdateScriptingPackagePayload,
  WorkshopListing,
  WorkshopPackageMetadata,
  WorkshopPackageSummary,
  WorkshopPublishResult,
} from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";
import { uint8ArrayToFile } from "@/utils/file-utils";

export async function createScriptingPackage(
  data: CreateScriptingPackagePayload
) {
  return apiClient.post<ScriptingPackage, CreateScriptingPackagePayload>(
    "scripting-packages",
    data
  );
}

/**
 * Reads one package by id, including its description and tags. The publish
 * dialog uses it to prefill a new workshop record from the room package.
 */
export async function getScriptingPackage(id: number) {
  return apiClient.get<ScriptingPackage, void>(`scripting-packages/${id}`);
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
  await apiClient.delete<void, void>(`scripting-packages/${id}`);
}

export type PackageSlugAvailability = {
  slug: string;
  available: boolean;
  reason?: "taken" | "retired";
  global: { available: boolean; reason?: "taken" | "retired" };
};

/**
 * Asks the backend whether a new package may use this slug. Slugs are locked
 * after creation, so a retired slug reports `retired` and cannot be reused.
 * Room slugs are only unique inside their room, so the global workshop scope is
 * reported separately and always checked by the caller.
 */
export async function checkPackageSlugAvailability(
  slug: string,
  roomId?: number
): Promise<PackageSlugAvailability> {
  return apiClient.get<
    PackageSlugAvailability,
    { slug: string; roomId?: number }
  >("scripting-packages/slug-availability", {
    slug,
    ...(roomId === undefined ? {} : { roomId }),
  });
}

// --- Workshop ---------------------------------------------------------------
// The workshop is the public catalogue of packages published from rooms. Copies
// (fork, add to room) run on the server and never mutate the source package.

export async function listWorkshopPackages(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<WorkshopListing> {
  return apiClient.get<
    WorkshopListing,
    { q?: string; limit?: number; offset?: number }
  >("scripting-packages/workshop", params);
}

export async function lookupWorkshopPackage(
  slug: string
): Promise<WorkshopPackageSummary | null> {
  const result = await apiClient.get<
    { package: WorkshopPackageSummary | null },
    { slug: string }
  >("scripting-packages/workshop/lookup", { slug });
  return result.package;
}

export async function publishPackageToWorkshop(
  id: number,
  metadata: WorkshopPackageMetadata
): Promise<WorkshopPublishResult> {
  return apiClient.post<WorkshopPublishResult, WorkshopPackageMetadata>(
    `scripting-packages/${id}/workshop`,
    metadata
  );
}

export async function forkPackageToWorkshop(
  id: number,
  slug: string
): Promise<ScriptingPackage> {
  return apiClient.post<ScriptingPackage, { slug: string }>(
    `scripting-packages/${id}/workshop-fork`,
    { slug }
  );
}

export async function copyWorkshopPackageToRoom(
  id: number,
  roomId: number
): Promise<ScriptingPackage> {
  return apiClient.post<ScriptingPackage, { roomId: number }>(
    `scripting-packages/${id}/room-copy`,
    { roomId }
  );
}

// --- Package revisions ------------------------------------------------------
// A revision is a set of files that is uploaded file by file and then
// published as an immutable snapshot served to the Godot server and clients.

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
