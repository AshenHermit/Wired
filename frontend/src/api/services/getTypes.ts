import { TypeFile } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

export async function getWiredIoTypes() {
  return await apiClient.get<TypeFile[], null>("types/wired-io");
}

export async function getLibsTypes() {
  return await apiClient.get<TypeFile[], null>("types/libs");
}
