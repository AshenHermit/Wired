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
  // server snapshot cadence (ms)
  syncIntervalMs = 50;
  syncAccumulatorMs = 0;
  b2Body: b2.Body;
  // client-side smoothing targets
  targetPos = new b2.Vec2(0, 0);
  targetVel = new b2.Vec2(0, 0);
  targetAngle = 0;
  hasSnapshot = false;

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
    // server applies immediately, client only updates targets to avoid snaps
    const newPos = new b2.Vec2(
      state.x ?? this.targetPos.x,
      state.y ?? this.targetPos.y
    );
    const newVel = new b2.Vec2(
      state.linearVelocity?.x ?? this.targetVel.x,
      state.linearVelocity?.y ?? this.targetVel.y
    );
    const newAngle = state.angle ?? this.targetAngle;

    if (Wired().network.isServer) {
      this.b2Body.SetLinearVelocity(newVel);
      this.b2Body.SetPosition(newPos);
      this.b2Body.SetAngle(newAngle);
      return;
    }

    this.targetPos = newPos;
    this.targetVel = newVel;
    this.targetAngle = newAngle;
    this.hasSnapshot = true;
  }
  update(time: number, delta: number): void {
    super.update(time, delta);

    if (Wired().network.isServer && this.b2Body.IsAwake()) {
      this.syncAccumulatorMs += delta;
      if (this.syncAccumulatorMs >= this.syncIntervalMs) {
        this.syncAccumulatorMs = 0;
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
    g_debugDraw.DrawCircle(
      new b2.Vec2(this.getNodeState().x, this.getNodeState().y),
      0.5,
      new b2.Color(255, 0, 0, 255)
    );

    if (!Wired().network.isServer && this.hasSnapshot) {
      // soft correction towards last snapshot to reduce jitter
      const alpha = Math.min(1, (12 * delta) / 1000); // ~12 lerp/sec
      const curPos = this.b2Body.GetPosition();
      const err = b2.Vec2.SubVV(this.targetPos, curPos, new b2.Vec2());
      const errLen = err.Length();
      const nextPos =
        errLen < 0.1
          ? this.targetPos
          : new b2.Vec2(
              Phaser.Math.Linear(curPos.x, this.targetPos.x, alpha),
              Phaser.Math.Linear(curPos.y, this.targetPos.y, alpha)
            );
      this.b2Body.SetPosition(nextPos);

      const curVel = this.b2Body.GetLinearVelocity();
      this.b2Body.SetLinearVelocity(
        new b2.Vec2(
          Phaser.Math.Linear(curVel.x, this.targetVel.x, alpha),
          Phaser.Math.Linear(curVel.y, this.targetVel.y, alpha)
        )
      );

      const nextAngle = Phaser.Math.Angle.RotateTo(
        this.b2Body.GetAngle(),
        this.targetAngle,
        alpha
      );
      this.b2Body.SetAngle(nextAngle);
    }

    const smoothness = (20.0 * delta) / 1000;
    this.setPosition(
      Phaser.Math.Linear(this.x, this.b2Body.GetPosition().x, smoothness),
      Phaser.Math.Linear(this.y, this.b2Body.GetPosition().y, smoothness)
    );
    this.setAngle(Phaser.Math.RadToDeg(this.b2Body.GetAngle()));
  }
}
