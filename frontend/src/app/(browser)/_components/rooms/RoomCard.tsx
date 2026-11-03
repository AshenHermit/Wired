"use client";

import type { Room } from "@wired-io/shared/api/types";
import { LiquidButton } from "@/components/animate-ui/components/buttons/liquid";
import {
  RippleButton,
  RippleButtonRipples,
} from "@/components/animate-ui/components/buttons/ripple";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useUserStore } from "@/store/user-store";
import { PlayIcon, WrenchIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { encodeId } from "@/utils/hash-utils";
import type { RoomEditingPanelAPI } from "./RoomEditingPanel";

/** One room tile; the edit affordance only shows for the room's own author. */
export function RoomCard({
  room,
  editingApi,
}: {
  room: Room;
  editingApi?: React.RefObject<RoomEditingPanelAPI | null>;
}) {
  const authorized = useUserStore((state) => state.authorized);
  const userId = useUserStore((state) => state.id);
  const canEdit = editingApi && authorized && userId === room.author?.id;
  return (
    <Card className="min-h-32">
      <CardHeader>
        <CardTitle>{room.name}</CardTitle>
      </CardHeader>
      <CardFooter className="flex justify-between">
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
    </Card>
  );
}
