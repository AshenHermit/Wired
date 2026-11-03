import { User } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

export function getProfile() {
  return apiClient.get<User>("users/profile");
}
