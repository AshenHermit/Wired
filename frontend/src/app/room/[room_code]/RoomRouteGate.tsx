"use client";
import React from "react";
import { useTranslations } from "next-intl";
import { RoomWorkspace } from "./_godot/RoomWorkspace";
import { Room } from "@wired-io/shared";
import { getRoom } from "@/api/services/rooms";
import { decodeId } from "@/utils/hash-utils";
import { Spinner } from "@/components/ui/spinner";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";
import { useAppMessage, type AppMessage } from "@/i18n/message";

export function RoomRouteGate({ roomCode }: { roomCode: string }) {
  const t = useTranslations("Room");
  const format = useAppMessage();
  const [room, setRoom] = React.useState<Room | null>(null);
  const [error, setError] = React.useState<AppMessage | null>(null);

  const loadRoom = React.useCallback(async () => {
    setError(null);
    try {
      const roomId = decodeId("room", roomCode);
      if (roomId === null) {
        throw new Error("Invalid room code");
      }
      setRoom(await getRoom(roomId));
    } catch (cause) {
      console.error(cause);
      setError({ key: "Room.loadFailed" });
    }
  }, [roomCode]);

  React.useEffect(() => {
    loadRoom();
  }, [loadRoom]);

  if (error != null) {
    return (
      <div className="w-screen h-screen flex items-center justify-center p-8 text-center">
        <LocaleSwitcher className="fixed right-4 top-4 z-20" />
        <div className="max-w-md space-y-2">
          <h1 className="text-xl font-semibold">{t("unavailable")}</h1>
          <p className="text-muted-foreground">{format(error)}</p>
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
        <LocaleSwitcher className="fixed right-4 top-4 z-20" />
        <div className="max-w-md space-y-2">
          <h1 className="text-xl font-semibold">{t("legacyTitle")}</h1>
          <p className="text-muted-foreground">{t("legacyDescription")}</p>
        </div>
      </div>
    );
  }
  return <RoomWorkspace room={room} onRoomSaved={setRoom} />;
}
