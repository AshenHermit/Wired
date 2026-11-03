import { CreateRoomPayload, Room, UpdateRoomPayload } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

export async function listRooms() {
  return apiClient.get<Room[]>("rooms");
}

export async function getRoom(id: number) {
  return apiClient.get<Room>(`rooms/${id}`);
}

export async function createRoom(data: CreateRoomPayload) {
  return apiClient.post<Room>("rooms", data);
}

export async function updateRoom(id: number, data: UpdateRoomPayload) {
  return apiClient.patch<Room>(`rooms/${id}`, data);
}

export async function deleteRoom(id: number) {
  return apiClient.delete<void>(`rooms/${id}`);
}
