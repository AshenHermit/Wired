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
};

function isAuthor(room: RoomAccessSubject, userId?: number | null): boolean {
  return userId != null && room.author?.id === userId;
}

function isContributor(room: RoomAccessSubject, userId?: number | null): boolean {
  return (
    userId != null &&
    (room.contributors ?? []).some((contributor) => contributor.id === userId)
  );
}

/**
 * Explicit membership: the room's author or one of its contributors.
 *
 * Distinct from `canViewRoom`, which also admits anyone to a public room. Use
 * this when the question is "does this user belong to this room" — editing and
 * publishing room-owned packages, runtime delivery — so a public room does not
 * hand those rights to every visitor.
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
