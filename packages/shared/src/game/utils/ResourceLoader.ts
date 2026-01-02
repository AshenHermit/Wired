import { NetworkAPIBase } from "../../networking";
import { Wired } from "../WiredGlobal";

export interface TextureLoadData {
  key?: string;
  url?: string;
}

declare global {
  var SERVER_ENV: boolean | undefined;
}

export class ResourceLoader {
  scene: Phaser.Scene;
  api: NetworkAPIBase;
  constructor(scene: Phaser.Scene, api: NetworkAPIBase) {
    this.scene = scene;
    this.api = api;
  }
  useLoader(
    requestProcess: (loader: Phaser.Loader.LoaderPlugin) => void,
    onComplete: () => void,
    onError: (error: any) => void
  ) {
    try {
      let loader = new Phaser.Loader.LoaderPlugin(this.scene);
      // ask the LoaderPlugin to load the texture
      requestProcess(loader);
      loader.crossOrigin = "anonymous";

      loader.once(Phaser.Loader.Events.COMPLETE, () => {
        onComplete();
      });
      loader.once(Phaser.Loader.Events.FILE_LOAD_ERROR, (e: unknown) => {
        console.error(e);
      });
      loader.start();
    } catch (error) {
      onError(error);
    }
  }
  fetchTexture(url: string): Promise<TextureLoadData | null> {
    return new Promise((resolve, reject) => {
      if (this.scene.textures.exists(url)) {
        resolve({ key: url, url });
        return;
      }
      this.useLoader(
        (loader) => {
          loader.image(url, `${this.api.backendUrl}/proxy?url=${url}`);
        },
        () => {
          resolve({ key: url, url });
        },
        (error) => {
          reject(error);
        }
      );
    });
  }
  fetchSpriteSheet(
    url: string,
    frameConfig?: Phaser.Types.Loader.FileTypes.ImageFrameConfig
  ): Promise<TextureLoadData | null> {
    return new Promise((resolve, reject) => {
      if (this.scene.textures.exists(url)) {
        resolve({ key: url, url });
        return;
      }
      this.useLoader(
        (loader) => {
          loader.spritesheet(
            url,
            `${this.api.backendUrl}/proxy?url=${url}`,
            frameConfig
          );
        },
        () => {
          resolve({ key: url, url });
        },
        (error) => {
          reject(error);
        }
      );
    });
  }
}
