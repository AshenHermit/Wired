import { UpdateUserPayload, User } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

/** Applies the patch and resolves with the stored user. */
export function updateUser(id: number, data: UpdateUserPayload) {
  return apiClient.patch<User>(`users/${id}`, data);
}
