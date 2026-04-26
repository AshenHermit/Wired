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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/animate-ui/components/radix/sheet";
import React from "react";
import { GodotRoomProvider, useGodotRoomContext } from "./GodotRoomProvider";

export function GodotRoomPageClient({ room }: { room: Room }) {
  const [isPackagesOpen, setIsPackagesOpen] = React.useState(false);
  const editorRef = React.useRef<GodotEditorApi>(null);

  return (
    <GodotRoomProvider>
      <div className="w-screen h-screen">
        <Tabs defaultValue="editor" className="w-full h-full !gap-0">
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
            <TabsContent value="game" className="">
              <div>Game</div>
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
