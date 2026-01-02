import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Sprite } from "./Sprite";
import { Node } from "./Node";
import { RegisteredNode } from "../NodesRegistry";
import { PlayerBase, PlayerBaseState } from "./PlayerBase";
import { RigidBody, RigidBodyState } from "./RigidBody";
import * as b2 from "@box2d";
import { KinematicBody } from "./KinematicBody";

export type TestPlayerState = PlayerBaseState & {};

@RegisteredNode("TestPlayer")
export class TestPlayer extends PlayerBase<TestPlayerState> {
  m_body: KinematicBody;

  constructor() {
    super();
    this.m_body = new KinematicBody();
    this.m_body.setName("body");
    this.add(this.m_body);
    const sprite = new Sprite(
      "https://i.pinimg.com/736x/bb/9c/99/bb9c99cbf55ca2042383ad5e7795b2e9.jpg"
    );
    sprite.setName("sprite");
    this.m_body.add(sprite);

    this.controls.onKeyDown("W", () => {
      this.m_body.b2Body.SetLinearVelocity(
        new b2.Vec2(this.m_body.b2Body.GetLinearVelocity().x, -15)
      );
    });
  }
  onNodeStateChanged(oldState: TestPlayerState, state: TestPlayerState): void {}
  update(time: number, delta: number): void {
    super.update(time, delta);
    const speed = 10;
    const movement = new b2.Vec2(0, 0);
    if (this.controls.isKeyDown("D")) {
      movement.x += speed;
    }
    if (this.controls.isKeyDown("A")) {
      movement.x -= speed;
    }
    movement.y = this.m_body.b2Body.GetLinearVelocity().y;
    this.m_body.b2Body.SetLinearVelocity(movement);
  }
}
