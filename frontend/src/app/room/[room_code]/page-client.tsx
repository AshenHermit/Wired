"use client";
import React from "react";
import { GodotRoomPageClient } from "./(godot)/RoomPageClient";
import { Room } from "@wired-io/shared";
import { getRoom } from "@/api/services/rooms";
import { decodeId } from "@/utils/hash-utils";
import { Spinner } from "@/components/ui/spinner";

export function RoomPageClient({ roomCode }: { roomCode: string }) {
  const [room, setRoom] = React.useState<Room | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const loadRoom = React.useCallback(async () => {
    setError(null);
    try {
      const roomId = decodeId("room", roomCode);
      if (roomId < 0) {
        throw new Error("Invalid room code");
      }
      setRoom(await getRoom(roomId));
    } catch {
      setError("Не удалось загрузить комнату. Проверьте ссылку и попробуйте ещё раз.");
    }
  }, [roomCode]);

  React.useEffect(() => {
    loadRoom();
  }, [loadRoom]);

  if (error != null) {
    return (
      <div className="w-screen h-screen flex items-center justify-center p-8 text-center">
        <div className="max-w-md space-y-2">
          <h1 className="text-xl font-semibold">Комната недоступна</h1>
          <p className="text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }
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
            Комнаты Phaser больше не поддерживаются
          </h1>
          <p className="text-muted-foreground">
            Эта комната использует устаревший режим ts-game. Создайте новую
            комнату Godot, чтобы продолжить.
          </p>
        </div>
      </div>
    );
  }
  return <GodotRoomPageClient room={room} />;
}
