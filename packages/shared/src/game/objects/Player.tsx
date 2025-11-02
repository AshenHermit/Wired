import React from "react";
import { Sprite, useSpriteApiRef } from "./Sprite";
import { useGame, useOnSceneEvent, useScene } from "../GameContext";
import { Node, useNodeApiRef } from "./Node";

export function Player({ name }: { name: string }) {
  const spriteRef = useSpriteApiRef();
  const scene = useScene();
  const nodeRef = useNodeApiRef();

  useOnSceneEvent(
    Phaser.Scenes.Events.UPDATE,
    () => {
      const sprite = spriteRef.current;
      if (!sprite) return;
      sprite.setPosition(sprite.x + 1, sprite.y + 1);
    },
    [spriteRef]
  );

  return (
    <Node name={name} ref={nodeRef}>
      <Sprite
        ref={spriteRef}
        textureUrl="https://www.makfa.ru/upload/resize_cache/iblock/b51/700_700_1/jrxkyz4f32hj3drs3akbgbln20qa3hzu.jpg"
      />
    </Node>
  );
}
