import { describe, expect, it, vi } from "vitest";
import type { Room, User } from "@wired-io/shared";

const { apiClient } = vi.hoisted(() => ({
  apiClient: {
    get: vi.fn(),
    getFile: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postFile: vi.fn(),
  },
}));

vi.mock("../api-client/api-client", () => ({ apiClient }));

import { getProfile } from "./profile";
import {
  createRoom,
  deleteRoom,
  getRoom,
  listRooms,
  updateRoom,
} from "./rooms";
import { updateUser } from "./users";

const room: Room = {
  id: 3,
  name: "Hero room",
  isPublic: true,
  description: "",
  type: "godot",
  parentRoomId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  author: { id: 7, name: "Ann", picture: "p" },
};

const user: User = {
  id: 7,
  email: "ann@wired.io",
  name: "Ann",
  service: "email",
  picture: "p",
};

describe("profile service", () => {
  it("answers null for the empty body of an anonymous caller", async () => {
    apiClient.get.mockResolvedValueOnce("");

    await expect(getProfile()).resolves.toBeNull();
  });

  it("returns the signed-in user", async () => {
    apiClient.get.mockResolvedValueOnce(user);

    await expect(getProfile()).resolves.toEqual(user);
    expect(apiClient.get).toHaveBeenCalledWith("users/profile");
  });
});

describe("rooms service", () => {
  it("lists rooms from the collection route", async () => {
    apiClient.get.mockResolvedValueOnce([room]);

    await expect(listRooms()).resolves.toEqual([room]);
    expect(apiClient.get).toHaveBeenCalledWith("rooms");
  });

  it("reads one room by id", async () => {
    apiClient.get.mockResolvedValueOnce(room);

    await expect(getRoom(3)).resolves.toEqual(room);
    expect(apiClient.get).toHaveBeenCalledWith("rooms/3");
  });

  it("creates a room with the payload it was given", async () => {
    apiClient.post.mockResolvedValueOnce(room);
    const payload = { name: "Hero room", isPublic: true, type: "godot" } as const;

    await expect(createRoom({ ...payload })).resolves.toEqual(room);
    expect(apiClient.post).toHaveBeenCalledWith("rooms", { ...payload });
  });

  it("patches only the changed fields", async () => {
    apiClient.patch.mockResolvedValueOnce(room);

    await expect(updateRoom(3, { name: "Renamed" })).resolves.toEqual(room);
    expect(apiClient.patch).toHaveBeenCalledWith("rooms/3", { name: "Renamed" });
  });

  it("resolves with no body after a delete", async () => {
    apiClient.delete.mockResolvedValueOnce(undefined);

    await expect(deleteRoom(3)).resolves.toBeUndefined();
    expect(apiClient.delete).toHaveBeenCalledWith("rooms/3");
  });
});

describe("users service", () => {
  it("returns the stored user after a patch", async () => {
    apiClient.patch.mockResolvedValueOnce(user);

    await expect(updateUser(7, { name: "Ann" })).resolves.toEqual(user);
    expect(apiClient.patch).toHaveBeenCalledWith("users/7", { name: "Ann" });
  });
});
