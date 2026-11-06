import { PublicUser, UpdateUserPayload, User } from "@wired-io/shared";
import { apiClient } from "../api-client/api-client";

/** Applies the patch and resolves with the stored user. */
export function updateUser(id: number, data: UpdateUserPayload) {
  return apiClient.patch<User>(`users/${id}`, data);
}

/** Searches users by name or email and resolves with public fields only. */
export function searchUsers(query: string, limit?: number) {
  return apiClient.get<PublicUser[]>("users/search", {
    q: query,
    ...(limit === undefined ? {} : { limit }),
  });
}
