import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Sprite } from "./Sprite";
import { Node } from "./Node";
import { RegisteredNode } from "../NodesRegistry";

export type PlayerState = {
  socketId: string;
  x?: number;
  y?: number;
};

@RegisteredNode("Player")
export class Player extends Node<PlayerState> {
  keyD?: Phaser.Input.Keyboard.Key = undefined;
  keyA?: Phaser.Input.Keyboard.Key = undefined;
  keyW?: Phaser.Input.Keyboard.Key = undefined;
  keyS?: Phaser.Input.Keyboard.Key = undefined;
  syncTimer = 0.1;
  syncTimerTimeout = 0.1;
  targetPosition = { x: 0, y: 0 };

  constructor() {
    super();
    this.keyD = Wired().scene().input.keyboard?.addKey("D");
    this.keyA = Wired().scene().input.keyboard?.addKey("A");
    this.keyW = Wired().scene().input.keyboard?.addKey("W");
    this.keyS = Wired().scene().input.keyboard?.addKey("S");
  }
  isLocal() {
    return Wired().network.localId == this.getNodeState().socketId;
  }
  addedToScene(): void {
    super.addedToScene();
    const sprite = new Sprite(
      "https://i.pinimg.com/1200x/91/71/3d/91713d3bcf2e4b805b462f6e057014ea.jpg"
    );
    sprite.setScale(0.1);
    this.add(sprite);
  }
  onNodeStateChanged(state: PlayerState): void {
    this.targetPosition.x = state.x ?? 0;
    this.targetPosition.y = state.y ?? 0;
  }
  setPosition(x?: number, y?: number, z?: number, w?: number): this {
    return super.setPosition(x, y, z, w);
  }
  preUpdate(time: number, delta: number): void {
    const position = { x: this.targetPosition.x, y: this.targetPosition.y };
    if (this.isLocal()) {
      if (this.keyD?.isDown) {
        position.x += 10;
      }
      if (this.keyA?.isDown) {
        position.x -= 10;
      }
      if (this.keyW?.isDown) {
        position.y -= 10;
      }
      if (this.keyS?.isDown) {
        position.y += 10;
      }
      if (this.syncTimer > 0) {
        this.syncTimer -= delta;
      } else {
        this.syncTimer = this.syncTimerTimeout;
        this.setNodeState({ x: position.x, y: position.y });
      }
    }

    this.setPosition(
      this.x + (position.x - this.x) / 5,
      this.y + (position.y - this.y) / 5
    );
  }
}
