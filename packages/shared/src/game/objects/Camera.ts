import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Node, Rpc } from "./Node";
import { RegisteredNode } from "../NodesRegistry";

export type CameraState = {};

@RegisteredNode("CameraNode")
export class CameraNode extends Node<CameraState> {
  camera: Phaser.Cameras.Scene2D.Camera | null = null;
  target: Node | null = null;
  targetPosition = new Phaser.Math.Vector2(0, 0);
  hardness = 10;
  constructor() {
    super();
  }
  setMainCamera() {
    this.camera = Wired().scene().cameras.main;
  }
  setTarget(target: Node) {
    this.target = target;
  }
  update(time: number, delta: number): void {
    super.update(time, delta);
    if (this.camera && this.target) {
      this.targetPosition.set(this.target.x, this.target.y);
      this.x = Phaser.Math.Linear(
        this.x,
        this.targetPosition.x,
        this.hardness * (delta / 1000)
      );
      this.y = Phaser.Math.Linear(
        this.y,
        this.targetPosition.y,
        this.hardness * (delta / 1000)
      );
      const worldPoint = this.getWorldPoint(
        new Phaser.Math.Vector2(this.x, this.y)
      );
      this.camera.centerOn(this.x, this.y);
    }
  }
}
