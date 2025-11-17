import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Sprite } from "./Sprite";
import { Node } from "./Node";
import { RegisteredNode } from "../NodesRegistry";
import { PlayerBase, PlayerBaseState } from "./PlayerBase";
import * as b2 from "@box2d";

export type RigidBodyState = {
  x?: number;
  y?: number;
  linearVelocity?: { x: number; y: number };
  angularVelocity?: number;
  angle?: number;
};

@RegisteredNode("RigidBody")
export class RigidBody extends Node<RigidBodyState> {
  syncTimer = 0.1;
  syncTimerTimeout = 0.1 * 1000;
  b2Body: b2.Body;

  constructor() {
    super();
    const shape = new b2.PolygonShape();
    shape.SetAsBox(0.5, 0.5);

    const fd = new b2.FixtureDef();
    fd.shape = shape;
    fd.density = 1.0;
    fd.friction = 0.3;
    const bd = new b2.BodyDef();
    bd.type = b2.BodyType.b2_dynamicBody;
    this.b2Body = Wired().scene().b2dWorld.CreateBody(bd);
    this.b2Body.CreateFixture(fd);
  }
  addedToScene(): void {
    super.addedToScene();
  }
  preDestroy(): void {
    if (Wired().game()) {
      Wired().scene().b2dWorld.DestroyBody(this.b2Body);
    }
    super.preDestroy();
  }

  onNodeStateChanged(oldState: RigidBodyState, state: RigidBodyState): void {
    this.b2Body.SetPosition(new b2.Vec2(state.x ?? 0, state.y ?? 0));
    this.b2Body.SetLinearVelocity(
      new b2.Vec2(state.linearVelocity?.x ?? 0, state.linearVelocity?.y ?? 0)
    );
    this.b2Body.SetAngularVelocity(state.angularVelocity ?? 0);
    this.b2Body.SetAngle(state.angle ?? 0);
  }
  setPosition(x?: number, y?: number): this {
    return super.setPosition(x, y);
  }
  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    const position = {
      x: this.b2Body.GetPosition().x,
      y: this.b2Body.GetPosition().y,
    };
    if (Wired().network.isServer) {
      if (this.syncTimer > 0) {
        this.syncTimer -= delta;
      } else {
        this.syncTimer = this.syncTimerTimeout;
        this.broadcastNodeState({
          x: position.x,
          y: position.y,
          linearVelocity: {
            x: this.b2Body.GetLinearVelocity().x,
            y: this.b2Body.GetLinearVelocity().y,
          },
          angularVelocity: this.b2Body.GetAngularVelocity(),
          angle: this.b2Body.GetAngle(),
        });
      }
    }

    const smoothness =
      0.3 /
      Phaser.Math.Clamp(
        Phaser.Math.Distance.Between(this.x, this.y, position.x, position.y),
        1,
        5
      );

    this.setPosition(
      Phaser.Math.Linear(this.x, position.x, smoothness),
      Phaser.Math.Linear(this.y, position.y, smoothness)
    );
    this.setAngle(Phaser.Math.RadToDeg(this.b2Body.GetAngle()));
  }
}
