import * as Phaser from "phaser";
import { createContext, useContext, useEffect, useState } from "react";
import * as React from "react";
import { GameScene } from "./GameScene";

export interface GameContextType {
  game: Phaser.Game | null;
}

const GameContext = createContext<GameContextType>({
  game: null,
});

export function useGame() {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error("useGame must be used within a GameProvider");
  }
  return context;
}

export function useScene() {
  const { game } = useGame();
  if (!game) return null;
  return game?.scene.getScene("GameScene");
}

export function useOnSceneEvent(
  event: string | symbol,
  callback: (...args: any[]) => void,
  deps: any[]
) {
  const cb = React.useCallback(callback, deps);
  const scene = useScene();
  React.useEffect(() => {
    if (!scene) return;
    scene.events.on(event, cb);
    return () => {
      scene.events.off(event, cb);
    };
  }, [cb, scene]);
}

export const GameProvider = ({
  children,
  config,
  game,
}: {
  children?: React.ReactNode;
  config?: Phaser.Types.Core.GameConfig;
  game?: Phaser.Game;
}) => {
  const [currentGame, setCurrentGame] = useState<Phaser.Game | null>(
    game ?? null
  );

  useEffect(() => {
    if (!config) return;
    const game = new Phaser.Game({ ...config, scene: GameScene });
    setCurrentGame(game);
    if (globalThis.window) {
      (globalThis.window as any).currentGame = game;
    }
    return () => {
      game.destroy(true);
      setCurrentGame(null);
    };
  }, [config]);

  const logChildren = (children, level = 0) => {
    React.Children.map(children, (child) => {
      if (React.isValidElement(child)) {
        if (typeof child.type === "function") {
          console.log(child.type.prototype.constructor.name);
        } else if (typeof child.type === "object") {
          if ((child.type as any).render) {
            console.log((child.type as any).displayName);
          }
        }
        if ((child.props as any).children) {
          logChildren((child.props as any).children, level + 1);
        }
      }
    });
  };
  React.useEffect(() => {
    setTimeout(() => {
      logChildren(children);
    }, 100);
  }, [children]);

  if (!currentGame) return null;

  return (
    <GameContext.Provider value={{ game: currentGame }}>
      {children}
    </GameContext.Provider>
  );
};
