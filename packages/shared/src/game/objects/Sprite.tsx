import * as Phaser from "phaser";
import * as React from "react";
import { useScene } from "../GameContext";
import { serverHost } from "../../networking";
import { useNode } from "./Node";

export interface TextureLoadData {
  key?: string;
  url?: string;
}

export function useTexture(url?: string) {
  const scene = useScene();
  const [textureLoadData, setTextureLoadData] = React.useState<TextureLoadData>(
    {}
  );
  React.useEffect(() => {
    if (!url) return;
    if (!scene) return;
    if (scene.textures.exists(url)) {
      setTextureLoadData({ key: url, url });
      return;
    }
    let loader = new Phaser.Loader.LoaderPlugin(scene);
    // ask the LoaderPlugin to load the texture
    loader.image(url, `${serverHost}/proxy?url=${url}`);
    loader.crossOrigin = "anonymous";

    loader.once(Phaser.Loader.Events.COMPLETE, () => {
      setTextureLoadData({ key: url, url });
    });
    loader.start();
  }, [url, scene]);
  return textureLoadData;
}

export type SpriteProps = {
  textureUrl?: string;
};

export function useSpriteApiRef(): React.RefObject<Phaser.GameObjects.Sprite | null> {
  const ref = React.useRef<Phaser.GameObjects.Sprite | null>(null);
  return ref;
}

export const Sprite = React.forwardRef<
  Phaser.GameObjects.Sprite | null,
  SpriteProps
>(({ textureUrl }, ref) => {
  const scene = useScene();
  const [sprite, setSprite] = React.useState<Phaser.GameObjects.Sprite | null>(
    null
  );
  const textureLoadData = useTexture(textureUrl);

  React.useImperativeHandle(
    ref,
    () => {
      return sprite as any;
    },
    [sprite]
  );

  React.useEffect(() => {
    if (!scene) return;
    try {
      const currentSprite = scene.add.sprite(0, 0, "");
      setSprite(currentSprite);
      return () => {
        currentSprite.destroy();
        setSprite(null);
      };
    } catch (e) {}
  }, [scene]);

  React.useEffect(() => {
    if (!sprite) return;
    if (textureLoadData.key) {
      sprite.setTexture(textureLoadData.key);
    }
  }, [sprite, textureLoadData]);

  return null;
});
Sprite.displayName = "Sprite";
