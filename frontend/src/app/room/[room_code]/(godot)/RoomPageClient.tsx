"use client";

import { Room } from "@wired-io/shared";
import { GodotEditor, GodotEditorApi } from "./GodotEditor";
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from "@/components/animate-ui/components/animate/tabs";
import { RippleButton } from "@/components/animate-ui/components/buttons/ripple";
import { GamepadIcon, PackageIcon, WrenchIcon } from "lucide-react";
import React from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/animate-ui/components/radix/sheet";
import { GodotRoomProvider } from "./GodotRoomProvider";
import { GameTab } from "./GameTab";

export function GodotRoomPageClient({ room }: { room: Room }) {
  const [isPackagesOpen, setIsPackagesOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState("editor");
  const [gameMounted, setGameMounted] = React.useState(false);
  const editorRef = React.useRef<GodotEditorApi>(null);

  const handleTabChange = React.useCallback((value: string) => {
    setActiveTab(value);
    if (value === "game") {
      // Mount lazily, then keep it mounted: switching to the editor must not
      // disconnect the player. Removing the iframe is what closes the peer.
      setGameMounted(true);
    }
  }, []);

  return (
    <GodotRoomProvider>
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
              <RippleButton
                variant="ghost"
                size="sm"
                onClick={() => setIsPackagesOpen(true)}
              >
                <PackageIcon />
                Packages
              </RippleButton>
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
              <GodotEditor ref={editorRef} />
            </TabsContent>
            <TabsContent value="game" className="w-full !h-full">
              {gameMounted && <GameTab room={room} />}
            </TabsContent>
          </TabsContents>
        </Tabs>
        <Sheet open={isPackagesOpen} onOpenChange={setIsPackagesOpen}>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Packages</SheetTitle>
              <SheetDescription>
                Here you can manage the packages for your game.
              </SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      </div>
    </GodotRoomProvider>
  );
}
