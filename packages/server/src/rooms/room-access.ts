import { RoomAccessMode } from '@wired-io/shared';

/**
 * Single source of truth for room visibility, membership and edit rights.
 *
 * Room visibility, room editing, package editing and "can I play this room"
 * used to be open-coded with slightly different semantics in RoomsService,
 * ScriptingPackagesService and GameRoomService. Keeping the rules here makes
 * them reviewable and testable in isolation.
 */
export type RoomAccessSubject = {
  isPublic: boolean;
  author?: { id: number } | null;
  contributors?: { id: number }[] | null;
  packageManagementAccess?: RoomAccessMode | null;
  packageManagementUserIds?: number[] | null;
  packageCreationAccess?: RoomAccessMode | null;
  packageCreationUserIds?: number[] | null;
  readAccess?: RoomAccessMode | null;
  readUserIds?: number[] | null;
};

function isAuthor(room: RoomAccessSubject, userId?: number | null): boolean {
  return userId != null && room.author?.id === userId;
}

function isContributor(
  room: RoomAccessSubject,
  userId?: number | null,
): boolean {
  return (
    userId != null &&
    (room.contributors ?? []).some((contributor) => contributor.id === userId)
  );
}

/**
 * The shared tail of every access policy: `'all'` admits any authenticated
 * user, `'users'` requires an exact match in the policy list, and `'author'`
 * (or an unknown mode) adds nobody beyond the owners the caller already
 * checked.
 */
function matchesAccess(
  access: RoomAccessMode | null | undefined,
  ids: number[] | null | undefined,
  userId?: number | null,
): boolean {
  if (access === 'all') {
    return userId != null;
  }

  if (access === 'users') {
    return userId != null && (ids ?? []).includes(userId);
  }

  return false;
}

/**
 * Explicit membership: the room's author or one of its contributors.
 *
 * Distinct from `canViewRoom`, which also admits anyone to a public room. Use
 * this when the question is "does this user belong to this room" — editing and
 * publishing room-owned packages — so a public room does not hand those rights
 * to every visitor.
 */
export function isRoomMember(
  room: RoomAccessSubject,
  userId?: number | null,
): boolean {
  return isAuthor(room, userId) || isContributor(room, userId);
}

export function canViewRoom(
  room: RoomAccessSubject,
  userId?: number | null,
): boolean {
  return room.isPublic || isRoomMember(room, userId);
}

/**
 * Editing a room (settings, deletion, playable access) belongs to its author.
 * Contributors can view the room but cannot change it.
 */
export function canEditRoom(
  room: RoomAccessSubject,
  userId?: number | null,
): boolean {
  return isAuthor(room, userId);
}

/**
 * Managing room packages: author always allowed, or users matching the access mode.
 */
export function canManageRoomPackages(
  room: RoomAccessSubject,
  userId?: number | null,
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
 * Creating room packages: author always allowed, or users matching the access mode.
 */
export function canCreateRoomPackages(
  room: RoomAccessSubject,
  userId?: number | null,
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
 * Reading room package data for runtime delivery: author always allowed, or
 * users matching the access mode. A `users` mode only expands beyond the
 * author — it never narrows the author out.
 */
export function canReadRoom(
  room: RoomAccessSubject,
  userId?: number | null,
): boolean {
  return (
    isAuthor(room, userId) ||
    matchesAccess(room.readAccess, room.readUserIds, userId)
  );
}
