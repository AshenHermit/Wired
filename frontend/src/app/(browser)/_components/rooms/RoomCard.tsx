"use client";

import type { Room } from "@wired-io/shared";
import { LiquidButton } from "@/components/animate-ui/components/buttons/liquid";
import {
  RippleButton,
  RippleButtonRipples,
} from "@/components/animate-ui/components/buttons/ripple";
import { PreviewThumbnail } from "@/components/media/PreviewThumbnail";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useUserStore } from "@/store/user-store";
import { PlayIcon, WrenchIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { encodeId } from "@/utils/hash-utils";
import type { RoomEditingPanelApi } from "./RoomEditingPanel";

/** One room tile; the edit affordance only shows for the room's own author. */
export function RoomCard({
  room,
  editingApi,
}: {
  room: Room;
  editingApi?: React.RefObject<RoomEditingPanelApi | null>;
}) {
  const authorized = useUserStore((state) => state.authorized);
  const userId = useUserStore((state) => state.id);
  const canEdit = editingApi && authorized && userId === room.author?.id;
  const preview = room.previewImage;

  return (
    <Card className="p-4">
      <div
        className={
          preview ? "flex items-start gap-3 h-full justify-between" : "h-full"
        }
      >
        {preview ? <PreviewThumbnail src={preview} className="" /> : null}
        <div className="min-w-0 flex-1">
          <CardHeader className="p-0">
            <CardTitle>{room.name}</CardTitle>
          </CardHeader>
          <CardFooter className="flex justify-between p-0">
            <div>{room.author?.name}</div>
            <div className="flex items-center gap-2">
              {canEdit ? (
                <RippleButton
                  variant={"outline"}
                  onClick={() => editingApi.current?.edit(room)}
                >
                  <WrenchIcon />
                  <RippleButtonRipples />
                </RippleButton>
              ) : null}
              <LiquidButton asChild>
                <Link href={`/room/${encodeId("room", room.id)}`}>
                  <PlayIcon />
                </Link>
              </LiquidButton>
            </div>
          </CardFooter>
        </div>
      </div>
    </Card>
  );
}
