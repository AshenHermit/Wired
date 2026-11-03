/**
 * One room id, one file name. The state directory of a runtime and its log file
 * must be derived the same way, otherwise a diagnostic file lands next to its
 * own state instead of inside it, or two rooms share a directory.
 *
 * Room ids are validated before they get here, but the replacement stays as a
 * second line of defence against path separators.
 */
export const safeRoomName = (roomId: string): string =>
  roomId.replace(/[^a-zA-Z0-9._-]/g, '_');
