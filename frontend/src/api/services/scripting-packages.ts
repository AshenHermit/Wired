import {
  CreateScriptingPackagePayload,
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

export async function uploadPhysicalFile(
  packageId: number,
  filepath: string,
  file: File
) {
  return apiClient.postFile<ScriptingPackage>(
    `scripting-packages/${packageId}/files/${filepath}`,
    file
  );
}
export async function uploadPhysicalFileAsUint8Array(
  packageId: number,
  filepath: string,
  file: Uint8Array
) {
  return apiClient.postFile<ScriptingPackage>(
    `scripting-packages/${packageId}/files/${filepath}`,
    uint8ArrayToFile(file, filepath, "application/octet-stream")
  );
}

export async function getPhysicalFile(packageId: number, filepath: string) {
  return apiClient.getFile<void>(
    `scripting-packages/${packageId}/files/${filepath}`
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
