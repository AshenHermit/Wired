import { serverHost } from "../../networking";
import { Wired } from "../WiredGlobal";

export interface TextureLoadData {
  key?: string;
  url?: string;
}

export function fetchTexture(
  scene: Phaser.Scene,
  url: string
): Promise<TextureLoadData> {
  return new Promise((resolve, reject) => {
    if (globalThis.SERVER_ENV) {
      resolve({});
      return;
    }
    try {
      if (scene.textures.exists(url)) {
        resolve({ key: url, url });
      }
      let loader = new Phaser.Loader.LoaderPlugin(scene);
      // ask the LoaderPlugin to load the texture
      loader.image(url, `${serverHost}/proxy?url=${url}`);
      loader.crossOrigin = "anonymous";

      loader.once(Phaser.Loader.Events.COMPLETE, () => {
        resolve({ key: url, url });
      });
      loader.start();
    } catch (error) {
      // reject(error);
    }
  });
}
