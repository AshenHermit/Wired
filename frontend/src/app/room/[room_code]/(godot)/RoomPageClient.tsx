"use client";

import { Room } from "@wired-io/shared";
import { GodotEditor } from "./GodotEditor";
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from "@/components/animate-ui/components/animate/tabs";
import { GamepadIcon, WrenchIcon } from "lucide-react";
import React from "react";
import { GameTab } from "./GameTab";

export function GodotRoomPageClient({ room }: { room: Room }) {
  const [activeTab, setActiveTab] = React.useState("editor");
  const [gameMounted, setGameMounted] = React.useState(false);

  const handleTabChange = React.useCallback((value: string) => {
    setActiveTab(value);
    if (value === "game") {
      // Mount lazily, then keep it mounted: switching to the editor must not
      // disconnect the player. Removing the iframe is what closes the peer.
      setGameMounted(true);
    }
  }, []);

  return (
    <div className="w-screen h-screen">
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="w-full h-full !gap-0"
      >
        <div className="absolute top-0 left-[60%] z-10">
          <TabsList>
            <TabsTrigger value="editor">
              <WrenchIcon /> Editor
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
            <GodotEditor roomId={room.id} />
          </TabsContent>
          <TabsContent value="game" className="w-full !h-full">
            {gameMounted && <GameTab room={room} />}
          </TabsContent>
        </TabsContents>
      </Tabs>
    </div>
  );
}
