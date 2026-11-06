import {
  CreateRoomPayload,
  Room,
  UpdateRoomAccessPayload,
  UpdateRoomPayload,
} from "@wired-io/shared";
import { apiClient } from "../api-client/api-client";

export function listRooms() {
  return apiClient.get<Room[]>("rooms");
}

export function getRoom(id: number) {
  return apiClient.get<Room>(`rooms/${id}`);
}

export function createRoom(data: CreateRoomPayload) {
  return apiClient.post<Room>("rooms", data);
}

export function updateRoom(id: number, data: UpdateRoomPayload) {
  return apiClient.patch<Room>(`rooms/${id}`, data);
}

export function updateRoomAccess(id: number, data: UpdateRoomAccessPayload) {
  return apiClient.patch<Room>(`rooms/${id}/access`, data);
}

export function deleteRoom(id: number) {
  return apiClient.delete<void>(`rooms/${id}`);
}
