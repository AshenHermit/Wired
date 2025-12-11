"use client";

import React from "react";
import { NetworkAPI, WiredInstance } from "@wired-io/client";
import { WiredEditor } from "./Editor";
import dynamic from "next/dynamic";
import { WiredInstanceState } from "@wired-io/shared";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/animate-ui/components/radix/popover";
import { Button } from "@/components/animate-ui/components/buttons/button";
import { Wrench } from "lucide-react";
import { Switch } from "@/components/animate-ui/components/radix/switch";
import { cn } from "@/lib/utils";

export function RoomPageClient({ roomCode }: { roomCode: string }) {
  const gameContainerId = "game-container";
  const [state, setState] = React.useState<WiredInstanceState>("connecting");
  const [wiredInstance, setWiredInstance] =
    React.useState<WiredInstance | null>(null);
  const [showDebug, setShowDebug] = React.useState(false);

  React.useEffect(() => {
    let wiredInstance: WiredInstance | null = null;
    const timeout = setTimeout(() => {
      wiredInstance = new WiredInstance({
        displayParent: gameContainerId,
        network: new NetworkAPI(),
      });
      wiredInstance.events.addListener("stateChanged", setState);
      wiredInstance.setup();
      setWiredInstance(wiredInstance);
    }, 10);
    return () => {
      clearTimeout(timeout);
      if (wiredInstance) wiredInstance.destroy();
    };
  }, [setState]);

  React.useEffect(() => {
    if (wiredInstance && state == "connected") {
      const debugCanvas = document.getElementById(
        "debug-canvas"
      ) as HTMLCanvasElement;
      wiredInstance.wiredGlobal.scene().g_debugDraw.m_ctx =
        debugCanvas.getContext("2d");
      debugCanvas.width = wiredInstance.game?.canvas.width ?? 0;
      debugCanvas.height = wiredInstance.game?.canvas.height ?? 0;
    }
  }, [wiredInstance, state]);

  return (
    <>
      <div className="grid grid-cols-2">
        <WiredEditor wiredInstance={wiredInstance} state={state} />
        <div className="flex flex-col gap-2 items-center">
          <div>{state}</div>
          <div id={gameContainerId} className="relative">
            <canvas
              id="debug-canvas"
              className={cn(
                "w-full h-full absolute top-0 left-0 pointer-events-none z-10",
                showDebug ? "block" : "hidden"
              )}
            ></canvas>
          </div>
          <div className="flex items-center">
            <Popover>
              <PopoverTrigger>
                <Button variant="outline">
                  <Wrench />
                </Button>
              </PopoverTrigger>
              <PopoverContent>
                <div>
                  <div className="flex items-center gap-2">
                    <Switch
                      onCheckedChange={setShowDebug}
                      checked={showDebug}
                    />
                    <div>Show Debug</div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
    </>
  );
}
