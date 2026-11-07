import { describe, expect, it } from "vitest";
import {
  canCreateRoomPackages,
  canEditPackage,
  canManageRoomPackages,
  canReadRoom,
  type PackageAccessSubject,
  type RoomAccessSubject,
} from "./room-access";

const room: RoomAccessSubject = {
  author: { id: 1 },
  packageManagementAccess: "users",
  packageManagementUserIds: [2],
  packageCreationAccess: "author",
  packageCreationUserIds: [],
};

describe("room package access helpers", () => {
  it("mirrors server room package rights", () => {
    expect(canManageRoomPackages(room, 1)).toBe(true);
    expect(canManageRoomPackages(room, 2)).toBe(true);
    expect(canManageRoomPackages(room, 3)).toBe(false);
  });

  it("lets package policy expand beyond room owners", () => {
    const pkg: PackageAccessSubject = {
      author: { id: 5 },
      editingAccess: "users",
      editingUserIds: [9],
    };
    expect(canEditPackage(pkg, 9, room)).toBe(true);
    expect(canEditPackage(pkg, 7, room)).toBe(false);
    expect(canEditPackage(pkg, 1, room)).toBe(true);
  });

  it("mirrors server room package creation rights", () => {
    const authorOnly: RoomAccessSubject = {
      author: { id: 1 },
      packageCreationAccess: "author",
    };
    expect(canCreateRoomPackages(authorOnly, 1)).toBe(true);
    expect(canCreateRoomPackages(authorOnly, 2)).toBe(false);

    const anyUser: RoomAccessSubject = {
      author: { id: 1 },
      packageCreationAccess: "all",
    };
    expect(canCreateRoomPackages(anyUser, 42)).toBe(true);
    expect(canCreateRoomPackages(anyUser, null)).toBe(false);
  });

  it("never grants rights to anonymous viewers", () => {
    const anyUser: RoomAccessSubject = {
      author: { id: 1 },
      packageManagementAccess: "all",
      packageCreationAccess: "all",
    };
    expect(canManageRoomPackages(anyUser, undefined)).toBe(false);
    expect(canCreateRoomPackages(anyUser, null)).toBe(false);

    const pkg: PackageAccessSubject = {
      author: { id: 5 },
      editingAccess: "all",
    };
    expect(canEditPackage(pkg, undefined, anyUser)).toBe(false);
  });

  it("always allows the room author, even in author mode", () => {
    const pkg: PackageAccessSubject = {
      author: { id: 5 },
      editingAccess: "author",
      editingUserIds: [],
    };
    expect(canEditPackage(pkg, 5, room)).toBe(true);
    // The room author keeps baseline access and cannot be locked out.
    expect(canEditPackage(pkg, 1, room)).toBe(true);
    // An unrelated authenticated user is still denied in author mode.
    expect(canEditPackage(pkg, 7, room)).toBe(false);
  });

  it("mirrors server room read rights", () => {
    const usersRoom: RoomAccessSubject = {
      author: { id: 1 },
      contributors: [{ id: 2 }],
      readAccess: "users",
      readUserIds: [2],
    };
    expect(canReadRoom(usersRoom, 2)).toBe(true);
    expect(canReadRoom(usersRoom, 1)).toBe(true);
    expect(canReadRoom(usersRoom, 3)).toBe(false);
    expect(canReadRoom(usersRoom, undefined)).toBe(false);

    const allRoom: RoomAccessSubject = {
      author: { id: 1 },
      readAccess: "all",
    };
    expect(canReadRoom(allRoom, 999)).toBe(true);
    expect(canReadRoom(allRoom, undefined)).toBe(false);

    const authorRoom: RoomAccessSubject = {
      author: { id: 1 },
      contributors: [{ id: 2 }],
      readAccess: "author",
      readUserIds: [],
    };
    expect(canReadRoom(authorRoom, 1)).toBe(true);
    expect(canReadRoom(authorRoom, 2)).toBe(false);

    const nullRoom: RoomAccessSubject = {
      author: { id: 1 },
      readAccess: null,
      readUserIds: null,
    };
    expect(canReadRoom(nullRoom, 1)).toBe(true);
    expect(canReadRoom(nullRoom, 3)).toBe(false);
  });
});
