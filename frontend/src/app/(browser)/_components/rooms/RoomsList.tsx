"use client";

import { Button } from "@/components/animate-ui/components/buttons/button";
import {
  RippleButton,
  RippleButtonRipples,
} from "@/components/animate-ui/components/buttons/ripple";
import { useAppMessage } from "@/i18n/message";
import { useUserStore } from "@/store/user-store";
import { PlusIcon, RefreshCcwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { RoomCard } from "./RoomCard";
import {
  RoomEditingPanel,
  type RoomEditingPanelAPI,
} from "./RoomEditingPanel";
import { useRooms } from "./use-rooms";

/** The room grid plus its reload, empty, error and "add one" affordances. */
export function RoomsList({ forCurrentUser = false }: { forCurrentUser?: boolean }) {
  const userId = useUserStore((state) => state.id);
  const authorized = useUserStore((state) => state.authorized);
  const { items, load, error } = useRooms(forCurrentUser ? userId : undefined);
  const editingApi = React.useRef<RoomEditingPanelAPI>(null);
  const t = useTranslations("Rooms");
  const format = useAppMessage();

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div>
        <Button variant={"outline"} onClick={load}>
          <RefreshCcwIcon />
        </Button>
      </div>
      {authorized ? (
        <RoomEditingPanel ref={editingApi} onChange={load} />
      ) : null}
      {error ? (
        <div className="text-center text-sm text-destructive w-full">
          {format(error)}
        </div>
      ) : null}
      {items.length === 0 && !error ? (
        <div className="text-center text-sm text-muted-foreground w-full">
          {forCurrentUser ? t("emptyOwn") : t("emptyAll")}
        </div>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
        {items.map((room) => (
          <RoomCard key={room.id} room={room} editingApi={editingApi} />
        ))}
      </div>
      {forCurrentUser && authorized ? (
        <div className="flex justify-center">
          <RippleButton
            variant="default"
            className="w-fit"
            size={"lg"}
            onClick={() => editingApi.current?.create()}
          >
            <PlusIcon />
            {t("addOne")}
            <PlusIcon />
            <RippleButtonRipples />
          </RippleButton>
        </div>
      ) : null}
    </>
  );
}
