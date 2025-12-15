import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Sprite } from "./Sprite";
import { Node } from "./Node";
import { RegisteredNode } from "../NodesRegistry";
import { PlayerBase, PlayerBaseState } from "./PlayerBase";
import * as b2 from "@box2d";
import { g_debugDraw } from "../utils/b2DebugDraw";

export type KinematicBodyState = {
  time: number;
  x?: number;
  y?: number;
  linearVelocity?: { x: number; y: number };
  angle?: number;
};

@RegisteredNode("KinematicBody")
export class KinematicBody extends Node<KinematicBodyState> {
  syncTimer = 0.1;
  syncTimerTimeout = 0.05 * 1000;
  b2Body: b2.Body;

  constructor() {
    super();

    const shape = new b2.CircleShape();
    shape.Set(new b2.Vec2(0, 0), 0.5);

    const fd = new b2.FixtureDef();
    fd.shape = shape;
    fd.density = 1.0;
    fd.friction = 0.8;
    const bd = new b2.BodyDef();
    bd.type = b2.BodyType.b2_dynamicBody;
    this.b2Body = Wired().scene().b2dWorld.CreateBody(bd);
    this.b2Body.SetFixedRotation(true);
    this.b2Body.CreateFixture(fd);
  }
  preDestroy(): void {
    if (Wired().game()) {
      Wired().scene().b2dWorld.DestroyBody(this.b2Body);
    }
    super.preDestroy();
  }
  onNodeStateChanged(
    oldState: KinematicBodyState,
    state: KinematicBodyState
  ): void {
    const newPos = new b2.Vec2(state.x ?? 0, state.y ?? 0);
    if (b2.Vec2.DistanceVV(newPos, this.b2Body.GetPosition()) > 2) {
    }
    this.b2Body.SetLinearVelocity(
      new b2.Vec2(state.linearVelocity?.x ?? 0, state.linearVelocity?.y ?? 0)
    );
    this.b2Body.SetPosition(newPos);
    this.b2Body.SetAngle(state.angle ?? 0);
  }
  update(time: number, delta: number): void {
    super.update(time, delta);

    if (Wired().network.isServer && this.b2Body.IsAwake()) {
      if (this.syncTimer > 0) {
        this.syncTimer -= delta;
      } else {
        this.syncTimer = this.syncTimerTimeout;
        this.storeNodeState({
          time: new Date().getTime(),
          x: this.b2Body.GetPosition().x,
          y: this.b2Body.GetPosition().y,
          linearVelocity: {
            x: this.b2Body.GetLinearVelocity().x,
            y: this.b2Body.GetLinearVelocity().y,
          },
          angle: this.b2Body.GetAngle(),
        });
        this.broadcastNodeState(this.getNodeState(), false);
      }
    }
    if (g_debugDraw.m_ctx) {
      //   g_debugDraw.m_ctx.ellipse(0, 0, 32, 32, 0, 0, 2 * Math.PI);
    }
    g_debugDraw.DrawCircle(
      new b2.Vec2(this.getNodeState().x, this.getNodeState().y),
      0.5,
      new b2.Color(255, 0, 0, 255)
    );

    let smoothness = (20.0 * delta) / 1000;
    this.setPosition(
      Phaser.Math.Linear(this.x, this.b2Body.GetPosition().x, smoothness),
      Phaser.Math.Linear(this.y, this.b2Body.GetPosition().y, smoothness)
    );
    // this.setPosition(this.b2Body.GetPosition().x, this.b2Body.GetPosition().y);
    this.setAngle(Phaser.Math.RadToDeg(this.b2Body.GetAngle()));
  }
}
