import { User } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

export async function getProfile() {
  return await apiClient.get<User, never>("users/profile");
}
