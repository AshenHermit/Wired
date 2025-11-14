import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";

export class Sprite extends Phaser.GameObjects.Sprite {
  constructor(url: string) {
    super(Wired().scene(), 0, 0, "empty", 0);
    Wired().fetchTexture(url, (data) => {
      this.setTexture(data.key ?? "empty", 0);
    });
  }
}
