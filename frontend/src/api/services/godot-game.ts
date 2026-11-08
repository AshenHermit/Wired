import {
  GODOT_PROJECT_ROUTE,
  GameRoomConnection,
  GameRoomRuntimeStatus,
  ProjectInfo,
  RoomPackagesStatus,
} from "@wired-io/shared";
import { withApiPrefix } from "@/utils/variables";
import { apiClient } from "../api-client/api-client";

export async function getGodotProjectInfo() {
  const info = await apiClient.get<ProjectInfo>(GODOT_PROJECT_ROUTE);
  // The backend answers with its own path; the browser fetches project files
  // through the Next rewrite.
  info.baseUrl = withApiPrefix(info.baseUrl);
  return info;
}

/**
 * Starts or reuses the room runtime and returns a fresh single-use ticket.
 * Call this for every connection attempt: tickets cannot be reused.
 */
export function createGameConnection(roomId: number) {
  return apiClient.post<GameRoomConnection>(
    `rooms/${roomId}/game/connection`
  );
}

/** Runtime status; the backend never starts Godot for this call. */
export function getGameRoomStatus(roomId: number) {
  return apiClient.get<GameRoomRuntimeStatus>(
    `rooms/${roomId}/game/status`
  );
}

/**
 * Published package revisions of the room and how far the runtime and its
 * clients have applied them. Used by the editor to catch up after Emit.
 */
export function stopRoomRuntime(roomId: number) {
  return apiClient.post(`rooms/${roomId}/game/stop`);
}

export function getRoomPackages(roomId: number) {
  return apiClient.get<RoomPackagesStatus>(
    `rooms/${roomId}/game/packages`
  );
}

export type RoomStateCleanupScope = "self" | "all-players" | "dynamic";

export function cleanupRoomState(
  roomId: number,
  scope: RoomStateCleanupScope,
) {
  return apiClient.post(`rooms/${roomId}/state/cleanup`, { scope });
}
