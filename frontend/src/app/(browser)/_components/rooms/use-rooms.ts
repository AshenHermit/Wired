"use client";

import { listRooms } from "@/api/services/rooms";
import type { AppMessage } from "@/i18n/message";
import type { Room } from "@wired-io/shared/api/types";
import * as React from "react";

/**
 * Loads every visible room once and optionally narrows the result to the rooms
 * of one author. Filtering happens client-side because the endpoint already
 * returns only the rooms the caller may see.
 */
export function useRooms(ofUserId?: number) {
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [error, setError] = React.useState<AppMessage | null>(null);
  const load = React.useCallback(async () => {
    try {
      setError(null);
      setRooms(await listRooms());
    } catch (cause) {
      console.error(cause);
      setError({ key: "Rooms.errors.load" });
    }
  }, []);

  const items = ofUserId
    ? rooms.filter((room) => room.author?.id === ofUserId)
    : rooms;
  return { items, load, error };
}
