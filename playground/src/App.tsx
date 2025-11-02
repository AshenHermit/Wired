import Phaser from "phaser";
import "./App.css";
import React from "react";
import {
  GameProvider,
  NetworkProvider,
  Node,
  Player,
  Sprite,
} from "@wired-io/shared";
import { NetworkAPI } from "@wired-io/client";

function App() {
  const gameContainerId = "game-container";
  const gameConfig: Phaser.Types.Core.GameConfig = React.useMemo(
    () => ({
      type: Phaser.AUTO,
      width: 800,
      height: 600,
      parent: gameContainerId,
      backgroundColor: "#000000",
    }),
    []
  );

  const api = React.useMemo(() => new NetworkAPI(), []);
  React.useEffect(() => {
    api.connect();
    (async () => {
      const room = await api.connectToRoom(1);
      console.log(room);
    })();
    return () => {
      api.disconnect();
    };
  }, [api]);

  return (
    <>
      <div>
        <div>lol</div>
        <div id={gameContainerId}></div>
        <NetworkProvider api={api}>
          <GameProvider config={gameConfig}>
            <Node name="root">
              <Player name="player1" />
            </Node>
          </GameProvider>
        </NetworkProvider>
      </div>
    </>
  );
}

export default App;
