/**
 * Single source of truth for room visibility and edit rights.
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

export function canViewRoom(
  room: RoomAccessSubject,
  userId?: number | null,
): boolean {
  if (room.isPublic) {
    return true;
  }
  if (isAuthor(room, userId)) {
    return true;
  }
  return (
    userId != null &&
    (room.contributors ?? []).some((contributor) => contributor.id === userId)
  );
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
