export type RoomAccessMode = "author" | "users" | "all";

/**
 * The smallest slice of a room needed to answer package-access questions.
 *
 * Kept separate from the full API `Room` type so these helpers stay usable
 * wherever a caller has a room fragment (e.g. room summaries, cached state)
 * without pulling the whole entity shape.
 */
export type RoomAccessSubject = {
  author?: { id: number } | null;
  contributors?: { id: number }[] | null;
  packageManagementAccess?: RoomAccessMode | null;
  packageManagementUserIds?: number[] | null;
  packageCreationAccess?: RoomAccessMode | null;
  packageCreationUserIds?: number[] | null;
  readAccess?: RoomAccessMode | null;
  readUserIds?: number[] | null;
};

/**
 * The smallest slice of a package needed to answer package-access questions.
 */
export type PackageAccessSubject = {
  author?: { id: number } | null;
  editingAccess?: RoomAccessMode | null;
  editingUserIds?: number[] | null;
};

function isAuthor(
  subject: { author?: { id: number } | null },
  userId?: number | null,
): boolean {
  return userId != null && subject.author?.id === userId;
}

/**
 * The shared tail of every access policy: `all` admits any authenticated user,
 * `users` requires an exact match in the policy list, and `author` (or an
 * unknown mode) adds nobody beyond the owners the caller already checked.
 */
function matchesAccess(
  access: RoomAccessMode | null | undefined,
  ids: number[] | null | undefined,
  userId: number | null | undefined,
): boolean {
  if (access === "all") {
    return userId != null;
  }

  if (access === "users") {
    return userId != null && (ids ?? []).includes(userId);
  }

  return false;
}

/**
 * Mirrors the server's room package-management rule: the room author is always
 * allowed, and the configured policy may admit further users.
 */
export function canManageRoomPackages(
  room: RoomAccessSubject,
  userId: number | null | undefined,
): boolean {
  return (
    isAuthor(room, userId) ||
    matchesAccess(
      room.packageManagementAccess,
      room.packageManagementUserIds,
      userId,
    )
  );
}

/**
 * Mirrors the server's room package-creation rule: the room author is always
 * allowed, and the configured policy may admit further users.
 */
export function canCreateRoomPackages(
  room: RoomAccessSubject,
  userId: number | null | undefined,
): boolean {
  return (
    isAuthor(room, userId) ||
    matchesAccess(
      room.packageCreationAccess,
      room.packageCreationUserIds,
      userId,
    )
  );
}

/**
 * Mirrors the server's room read rule: the room author is always allowed, and
 * the configured policy may admit further users.
 */
export function canReadRoom(
  room: RoomAccessSubject,
  userId: number | null | undefined,
): boolean {
  return (
    isAuthor(room, userId) ||
    matchesAccess(room.readAccess, room.readUserIds, userId)
  );
}

/**
 * Mirrors the server's package-editing rule. The package author and the room
 * author are always allowed — a package policy can only expand access beyond
 * those baseline owners, never remove them. In `all` mode any authenticated
 * user may edit; in `users` mode users listed in `editingUserIds` may edit; in
 * `author` mode only the package author may edit.
 *
 * `room` is supplied separately (rather than read from `pkg.room`) because the
 * frontend already carries the room the user is inside, and the server's rule
 * only ever compares against that room's author.
 */
export function canEditPackage(
  pkg: PackageAccessSubject,
  userId: number | null | undefined,
  room: RoomAccessSubject,
): boolean {
  if (isAuthor(pkg, userId)) {
    return true;
  }

  // The room author is always allowed, regardless of the policy.
  if (isAuthor(room, userId)) {
    return true;
  }

  return matchesAccess(pkg.editingAccess, pkg.editingUserIds, userId);
}
