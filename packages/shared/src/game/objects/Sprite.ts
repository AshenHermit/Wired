import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";

export class Sprite extends Phaser.GameObjects.Sprite {
  constructor(url: string) {
    super(Wired().scene(), 0, 0, "empty", 0);
    this.setScale(0.001);
    Wired().fetchTexture(url, (data) => {
      this.setTexture(data.key ?? "empty", 0);
      const texture = Wired()
        .scene()
        .textures.get(data.key ?? "empty");
      const bounds = texture.getFrameBounds(0);
      console.log(bounds);
      var scale = 1 / Math.max(bounds.width, bounds.height);
      this.setScale(scale);
    });
  }
}
