import { UpdateUserPayload } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

export function updateUser(id: number, data: UpdateUserPayload) {
  return apiClient.patch<void>(`users/${id}`, data);
}
