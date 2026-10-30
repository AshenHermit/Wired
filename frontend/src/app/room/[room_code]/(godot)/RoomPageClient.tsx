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
import { GamepadIcon, PackageIcon, WrenchIcon } from "lucide-react";
import React from "react";
import { GameTab } from "./GameTab";
import { useUserStore } from "@/store/user-store";

export function GodotRoomPageClient({ room }: { room: Room }) {
  const [activeTab, setActiveTab] = React.useState("editor");
  const [gameMounted, setGameMounted] = React.useState(false);
  const roomPackages = React.useMemo(
    () => room.scriptingPackages ?? [],
    [room.scriptingPackages],
  );
  const packages = useRoomPackages(room.id, roomPackages);
  const userId = useUserStore((state) => state.id);
  const authorId = userId > 0 ? userId : null;

  const handleTabChange = React.useCallback((value: string) => {
    setActiveTab(value);
    if (value === "game") {
      // Mount lazily, then keep it mounted: switching to the editor must not
      // disconnect the player. Removing the iframe is what closes the peer.
      setGameMounted(true);
    }
  }, []);

  return (
    <div className="relative w-screen h-screen">
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="w-full h-full !gap-0"
      >
        <div className="absolute top-0 left-[52%] z-10">
          <TabsList>
            <TabsTrigger value="editor">
              <WrenchIcon /> Editor
            </TabsTrigger>
            <TabsTrigger value="packages">
              <PackageIcon /> Packages
            </TabsTrigger>
            <TabsTrigger value="game">
              <GamepadIcon />
              Game
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContents
          className="w-full !h-full relative"
          motionDivProps={{
            style: { justifyItems: "stretch", height: "100%" },
          }}
        >
          <TabsContent value="editor" className="w-full !h-full">
            <GodotEditor
              roomId={room.id}
              beforeStart={packages.beforeEditorStart}
            />
          </TabsContent>
          <TabsContent value="packages" className="w-full !h-full">
            <PackagesTab packages={packages} authorId={authorId} />
          </TabsContent>
          <TabsContent value="game" className="w-full !h-full">
            {gameMounted && <GameTab room={room} />}
          </TabsContent>
        </TabsContents>
      </Tabs>
    </div>
  );
}
