import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";

export class Sprite extends Phaser.GameObjects.Sprite {
  constructor(url?: string) {
    super(Wired().scene(), 0, 0, "empty", 0);
    this.setScale(0.001);

    if (url) this.loadTexture(url);
  }
  play(
    key:
      | string
      | Phaser.Animations.Animation
      | Phaser.Types.Animations.PlayAnimationConfig,
    ignoreIfPlaying?: boolean
  ) {
    try {
      return super.play(key, ignoreIfPlaying);
    } catch (error) {
      console.error(error);
    }
    return this;
  }
  async loadTexture(url) {
    const data = await Wired().resourceLoader.fetchTexture(url);
    if (!data) return;
    const key = data.key ?? "empty";
    this.setTexture(key, 0);
    const texture = Wired().scene().textures.get(key);
    const bounds = texture.getFrameBounds(0);
    console.log(bounds);
    var scale = 1 / Math.max(bounds.width, bounds.height);
    this.setScale(scale);
    return texture;
  }
  async loadSpriteSheet(
    url: string,
    frameConfig?: Phaser.Types.Loader.FileTypes.ImageFrameConfig
  ) {
    const data = await Wired().resourceLoader.fetchSpriteSheet(
      url,
      frameConfig
    );
    if (!data) return;
    const key = data.key ?? "empty";
    this.setTexture(key, 0);
    const texture = Wired().scene().textures.get(key);
    const frames = texture.getFramesFromTextureSource(0);
    const frame = frames[0];
    var scale = 1 / Math.max(frame.width, frame.height);
    this.setScale(scale);
    return texture;
  }
}
