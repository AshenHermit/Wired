import { User } from "./types";
import { apiClient } from "../api-client/client-api";

export async function getProfile(data?: {}) {
  return await apiClient.get<User, typeof data>("users/profile");
}
