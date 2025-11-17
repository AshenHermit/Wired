"use client";

import React from "react";
import { NetworkAPI, WiredInstance } from "@wired-io/client";
import { WiredEditor } from "./Editor";
import dynamic from "next/dynamic";
import { WiredInstanceState } from "@wired-io/shared";

export function RoomPageClient({ roomCode }: { roomCode: string }) {
  const gameContainerId = "game-container";
  const [state, setState] = React.useState<WiredInstanceState>("connecting");
  const [wiredInstance, setWiredInstance] =
    React.useState<WiredInstance | null>(null);

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

  return (
    <>
      <div className="grid grid-cols-2">
        <WiredEditor wiredInstance={wiredInstance} state={state} />
        <div className="flex flex-col gap-2 items-center">
          <div>{state}</div>
          <div id={gameContainerId}></div>
        </div>
      </div>
    </>
  );
}
