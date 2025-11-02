import * as Phaser from "phaser";
import { useGame } from "./GameContext";

export class GameScene extends Phaser.Scene {
  constructor() {
    super({
      key: "GameScene",
    });
  }
  create() {
    this.events.emit("scene-ready");
  }
}
