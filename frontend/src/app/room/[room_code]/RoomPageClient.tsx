"use client";

import React from "react";
import { NetworkAPI, WiredInstance } from "@wired-io/client";
import { WiredEditor } from "./Editor";
import dynamic from "next/dynamic";
import { NetworkMetricsState, WiredInstanceState } from "@wired-io/shared";
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
import { BACKEND_URL, WEBSOCKET_URL } from "@/utils/variables";
import { decodeId } from "@/utils/hash-utils";

export function RoomPageClient({ roomCode }: { roomCode: string }) {
  const gameContainerId = "game-container";
  const [state, setState] = React.useState<WiredInstanceState>("connecting");
  const [wiredInstance, setWiredInstance] =
    React.useState<WiredInstance | null>(null);
  const [showDebug, setShowDebug] = React.useState(false);
  const [throttling, setThrottling] = React.useState(0);

  React.useEffect(() => {
    let wiredInstance: WiredInstance | null = null;
    const timeout = setTimeout(() => {
      wiredInstance = new WiredInstance(
        {
          displayParent: gameContainerId,
          network: new NetworkAPI(WEBSOCKET_URL, BACKEND_URL),
        },
        decodeId("room", roomCode)
      );
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
      wiredInstance.wiredGlobal!.scene().g_debugDraw.m_ctx =
        debugCanvas.getContext("2d");
      debugCanvas.width = wiredInstance.game?.canvas.width ?? 0;
      debugCanvas.height = wiredInstance.game?.canvas.height ?? 0;
    }
  }, [wiredInstance, state]);

  React.useEffect(() => {
    if (wiredInstance && state == "connected") {
      wiredInstance.network.throttling = throttling;
      return () => {
        wiredInstance.network.throttling = 0;
      };
    }
  }, [wiredInstance, state, throttling]);

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
          <div className="flex items-center flex-col gap-2">
            <Popover>
              <PopoverTrigger>
                <Button variant="outline">
                  <Wrench />
                </Button>
              </PopoverTrigger>
              <PopoverContent>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      onCheckedChange={setShowDebug}
                      checked={showDebug}
                    />
                    <div>Show Debug</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      onCheckedChange={(value) => setThrottling(value ? 60 : 0)}
                      checked={throttling > 0}
                    />
                    <div>Use Throttling</div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <NetworkMetrics wiredInstance={wiredInstance} state={state} />
          </div>
        </div>
      </div>
    </>
  );
}

export function NetworkMetrics({
  wiredInstance,
  state,
}: {
  wiredInstance: WiredInstance | null;
  state: WiredInstanceState;
}) {
  const [networkMetrics, setNetworkMetrics] =
    React.useState<NetworkMetricsState | null>(null);

  React.useEffect(() => {
    if (wiredInstance && state == "connected") {
      const node = wiredInstance.wiredGlobal!.scene().networkMetricsNode;
      const recievedState = (state: NetworkMetricsState) => {
        setNetworkMetrics(state);
      };
      if (node) node.metricsEvents.addListener("recievedState", recievedState);
      return () => {
        if (node) node.metricsEvents.removeListener(recievedState);
      };
    }
  }, [wiredInstance, state]);

  return (
    <div>
      <div>Ping: {networkMetrics?.ping}ms</div>
    </div>
  );
}
