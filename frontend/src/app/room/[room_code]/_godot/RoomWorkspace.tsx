"use client";

import { Room } from "@wired-io/shared";
import { GodotEditor } from "./GodotEditor";
import { PackagesTab } from "./PackagesTab";
import { useRoomPackages } from "./use-room-packages";
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from "@/components/animate-ui/components/animate/tabs";
import {
  GamepadIcon,
  GripVerticalIcon,
  PackageIcon,
  WrenchIcon,
} from "lucide-react";
import React from "react";
import { useTranslations } from "next-intl";
import { GameTab } from "./GameTab";
import { useUserStore } from "@/store/user-store";
import {
  ROOM_TABS_POSITION_KEY,
  useDraggablePanel,
} from "./use-draggable-panel";
import {
  canCreateRoomPackages,
  canManageRoomPackages,
} from "@/utils/room-access";

export function RoomWorkspace({
  room,
  onRoomSaved,
}: {
  room: Room;
  /** Receives the room returned by the access settings save. */
  onRoomSaved: (room: Room) => void;
}) {
  const t = useTranslations("Room");
  const [activeTab, setActiveTab] = React.useState("editor");
  const [gameMounted, setGameMounted] = React.useState(false);
  const roomPackages = React.useMemo(
    () => room.scriptingPackages ?? [],
    [room.scriptingPackages],
  );
  const packages = useRoomPackages(room.id, roomPackages);
  const userId = useUserStore((state) => state.id);
  const viewerId = userId > 0 ? userId : null;
  const canCreatePackages = canCreateRoomPackages(room, viewerId);
  const canManagePackages = canManageRoomPackages(room, viewerId);
  const { panelRef, gripProps, style, isDragging } = useDraggablePanel({
    storageKey: ROOM_TABS_POSITION_KEY,
    initialPosition: (viewport) => ({
      x: Math.round(viewport.width * 0.52),
      y: 0,
    }),
  });

  const handleTabChange = React.useCallback((value: string) => {
    setActiveTab(value);
    if (value === "game") {
      // Mount lazily, then keep it mounted: switching to the editor must not
      // disconnect the player. Removing the iframe is what closes the peer.
      setGameMounted(true);
      // Returning to the Game tab must hand keyboard focus back to the game
      // iframe; otherwise keys go to the document and WASD stops working.
      window.requestAnimationFrame(() => {
        const frame = document.querySelector(
          'iframe[title="Wired game"]',
        ) as HTMLIFrameElement | null;
        frame?.focus();
      });
    }
  }, []);

  return (
    <div className="relative w-screen h-screen">
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="w-full h-full !gap-0"
      >
        <div
          ref={panelRef}
          className="fixed left-0 top-0 z-10 flex h-9 w-fit items-center gap-1"
          style={style}
        >
          <button
            type="button"
            aria-label={t("dragPanel")}
            title={t("dragPanel")}
            {...gripProps}
            className={`inline-flex h-9 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
          >
            <GripVerticalIcon className="size-4" />
          </button>
          <TabsList>
            <TabsTrigger value="editor">
              <WrenchIcon /> {t("tabs.editor")}
            </TabsTrigger>
            <TabsTrigger value="packages">
              <PackageIcon /> {t("tabs.packages")}
            </TabsTrigger>
            <TabsTrigger value="game">
              <GamepadIcon />
              {t("tabs.game")}
            </TabsTrigger>
          </TabsList>
        </div>
        {isDragging && (
          <div
            aria-hidden="true"
            className="fixed inset-0 z-20 cursor-grabbing"
          />
        )}
        <TabsContents
          className="w-screen !h-full relative"
          childClass="w-screen"
          motionDivProps={{
            style: { justifyItems: "stretch", height: "100%" },
          }}
        >
          <TabsContent value="editor" className="w-screen !h-full">
            <GodotEditor
              roomId={room.id}
              afterStart={packages.afterEditorStart}
            />
          </TabsContent>
          <TabsContent value="packages" className="w-screen !h-full">
            <PackagesTab
              packages={packages}
              canManagePackages={canManagePackages}
              canCreatePackages={canCreatePackages}
              viewerId={viewerId}
              roomId={room.id}
              room={room}
              onRoomSaved={onRoomSaved}
            />
          </TabsContent>
          <TabsContent value="game" className="w-screen !h-full">
            {gameMounted && <GameTab room={room} />}
          </TabsContent>
        </TabsContents>
      </Tabs>
    </div>
  );
}
