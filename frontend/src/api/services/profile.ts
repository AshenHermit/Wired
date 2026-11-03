import { User } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

/**
 * The signed-in user, or null when the caller has no session.
 *
 * `GET /users/profile` is guarded by the silent strategy, which answers 200
 * with an empty body instead of 401, so absence is a normal answer here.
 */
export async function getProfile(): Promise<User | null> {
  const profile = await apiClient.get<User | "">("users/profile");
  return profile === "" ? null : profile;
}
