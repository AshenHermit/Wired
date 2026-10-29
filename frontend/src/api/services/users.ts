import { UpdateUserPayload } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

export async function updateUser(id: number, data: UpdateUserPayload) {
  return apiClient.patch<void, UpdateUserPayload>(`users/${id}`, data);
}

export async function deleteUser(id: number) {
  return apiClient.delete<void, void>(`users/${id}`);
}
