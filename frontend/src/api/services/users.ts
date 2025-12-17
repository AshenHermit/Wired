import { CreateUserPayload, UpdateUserPayload, User } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

export async function listUsers() {
  return apiClient.get<User[], void>("users");
}

export async function getUser(id: number) {
  return apiClient.get<User, void>(`users/${id}`);
}

export async function createUser(data: CreateUserPayload) {
  return apiClient.post<User, CreateUserPayload>("users", data);
}

export async function updateUser(id: number, data: UpdateUserPayload) {
  return apiClient.patch<void, UpdateUserPayload>(`users/${id}`, data);
}

export async function deleteUser(id: number) {
  return apiClient.delete<void, void>(`users/${id}`);
}
