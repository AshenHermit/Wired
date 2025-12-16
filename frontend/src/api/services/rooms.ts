import { apiClient } from "../api-client/client-api";
import { CreateRoomPayload, Room, UpdateRoomPayload } from "./types";

export async function listRooms() {
  return apiClient.get<Room[], void>("rooms");
}

export async function getRoom(id: number) {
  return apiClient.get<Room, void>(`rooms/${id}`);
}

export async function createRoom(data: CreateRoomPayload) {
  return apiClient.post<Room, CreateRoomPayload>("rooms", data);
}

export async function updateRoom(id: number, data: UpdateRoomPayload) {
  return apiClient.patch<Room, UpdateRoomPayload>(`rooms/${id}`, data);
}

export async function deleteRoom(id: number) {
  return apiClient.delete<void, void>(`rooms/${id}`);
}
