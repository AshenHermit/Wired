import {
  GameRoomConnection,
  GameRoomRuntimeStatus,
  ProjectInfo,
} from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

export async function getGodotProjectInfo() {
  const info = await apiClient.get<ProjectInfo, void>(
    "godot-project-info/wired"
  );
  info.baseUrl = "/api" + info.baseUrl;
  return info;
}

/**
 * Starts or reuses the room runtime and returns a fresh single-use ticket.
 * Call this for every connection attempt: tickets cannot be reused.
 */
export async function createGameConnection(roomId: number) {
  return apiClient.post<GameRoomConnection, void>(
    `rooms/${roomId}/game/connection`
  );
}

/** Runtime status; the backend never starts Godot for this call. */
export async function getGameRoomStatus(roomId: number) {
  return apiClient.get<GameRoomRuntimeStatus, void>(
    `rooms/${roomId}/game/status`
  );
}
