"use client";
import React from "react";
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
    return (
      <div className="w-screen h-screen flex items-center justify-center p-8 text-center">
        <div className="max-w-md space-y-2">
          <h1 className="text-xl font-semibold">
            Phaser rooms are no longer supported
          </h1>
          <p className="text-muted-foreground">
            This room uses the retired ts-game mode. Create a new Godot room to
            continue.
          </p>
        </div>
      </div>
    );
  }
  return <GodotRoomPageClient room={room} />;
}
