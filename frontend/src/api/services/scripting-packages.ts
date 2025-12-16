import { apiClient } from "../api-client/client-api";
import {
  CreateScriptingPackagePayload,
  ScriptingPackage,
  UpdateScriptingPackagePayload,
} from "./types";

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
