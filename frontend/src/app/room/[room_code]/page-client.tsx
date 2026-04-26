"use client";
import React from "react";
import { TSRoomPageClientNoSSR } from "./(ts-game)/RoomPageClientNoSSr";
import { GodotRoomPageClient } from "./(godot)/RoomPageClient";
import { Room } from "@wired-io/shared";
import { getRoom } from "@/api/services/rooms";
import { decodeId } from "@/utils/hash-utils";
import { Spinner } from "@/components/ui/spinner";

export function RoomPageClient({ roomCode }: { roomCode: string }) {
  const [room, setRoom] = React.useState<Room | null>(null);

  const loadRoom = React.useCallback(async () => {
    const room = await getRoom(decodeId("room", roomCode));
    setRoom(room);
  }, [roomCode]);

  React.useEffect(() => {
    loadRoom();
  }, [loadRoom]);

  if (room == null) {
    return (
      <div className="w-screen h-screen flex items-center justify-center">
        <Spinner className="scale-200" />
      </div>
    );
  }
  if (room.type === "ts-game") {
    return <TSRoomPageClientNoSSR room={room} />;
  }
  if (room.type === "godot") {
    return <GodotRoomPageClient room={room} />;
  }
}
