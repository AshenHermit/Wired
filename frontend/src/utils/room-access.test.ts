import { describe, expect, it } from "vitest";
import {
  canCreateRoomPackages,
  canEditPackage,
  canManageRoomPackages,
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
});
