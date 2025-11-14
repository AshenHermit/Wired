import "./App.css";
import React from "react";
import { NetworkAPI, WiredInstance } from "@wired-io/client";
import { WiredEditor } from "./Editor";

function App() {
  const gameContainerId = "game-container";
  const [state, setState] = React.useState<string>("loading...");
  const wiredInstanceRef = React.useRef<WiredInstance>(null);

  React.useEffect(() => {
    let wiredInstance: WiredInstance | null = null;
    const timeout = setTimeout(() => {
      wiredInstance = new WiredInstance({
        displayParent: gameContainerId,
        network: new NetworkAPI(),
      });
      wiredInstance.events.addListener("stateChanged", setState);
      wiredInstance.setup();
      wiredInstanceRef.current = wiredInstance;
    }, 10);
    return () => {
      clearTimeout(timeout);
      if (wiredInstance) wiredInstance.destroy();
    };
  }, [setState]);

  return (
    <>
      <div>
        <div>
          <div>{state}</div>
        </div>
        <WiredEditor wiredInstanceRef={wiredInstanceRef} />
        <div id={gameContainerId}></div>
      </div>
    </>
  );
}

export default App;
