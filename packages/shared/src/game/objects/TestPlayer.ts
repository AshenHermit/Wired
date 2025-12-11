import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Sprite } from "./Sprite";
import { Node } from "./Node";
import { RegisteredNode } from "../NodesRegistry";
import { PlayerBase, PlayerBaseState } from "./PlayerBase";
import { RigidBody, RigidBodyState } from "./RigidBody";
import * as b2 from "@box2d";

export type TestPlayerState = PlayerBaseState & {
  rigidBodyState?: RigidBodyState;
};

@RegisteredNode("TestPlayer")
export class TestPlayer extends PlayerBase<TestPlayerState> {
  rigidBody: RigidBody;

  constructor() {
    super();
    super.addedToScene();
    this.rigidBody = new RigidBody();
    this.rigidBody.setName("rigidBody");
    this.add(this.rigidBody);
    const sprite = new Sprite(
      "https://i.pinimg.com/736x/bb/9c/99/bb9c99cbf55ca2042383ad5e7795b2e9.jpg"
    );
    sprite.setName("sprite");
    this.rigidBody.add(sprite);

    this.controls.onKeyDown("W", () => {
      // this.rigidBody.b2Body.ApplyLinearImpulseToCenter(
      //   new b2.Vec2(0, -10),
      //   true
      // );
    });
  }
  onNodeStateChanged(oldState: TestPlayerState, state: TestPlayerState): void {
    if (state.rigidBodyState) {
      this.rigidBody.setNodeState(state.rigidBodyState);
    }
  }
  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    const speed = 100;
    if (true) {
      if (this.controls.isKeyDown("D")) {
        this.rigidBody.b2Body.ApplyForceToCenter(new b2.Vec2(speed, 0), true);
      }
      if (this.controls.isKeyDown("A")) {
        this.rigidBody.b2Body.ApplyForceToCenter(new b2.Vec2(-speed, 0), true);
      }
      if (this.controls.isKeyDown("W")) {
        this.rigidBody.b2Body.ApplyForceToCenter(new b2.Vec2(0, -speed), true);
      }
      if (this.controls.isKeyDown("S")) {
        this.rigidBody.b2Body.ApplyForceToCenter(new b2.Vec2(0, speed), true);
      }
    }
    this.storeNodeState({ rigidBodyState: this.rigidBody.getNodeState() });
  }
}
