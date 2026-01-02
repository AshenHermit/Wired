import { libFunc } from "./lib";
import {
  Wired,
  RegisteredNode,
  PlayerBase,
  PlayerBaseState,
  KinematicBody,
  Sprite,
  CameraNode,
  RigidBody,
} from "@wired-io";
import * as b2 from "@box2d";

export type RPGPlayerBaseState = PlayerBaseState & {};

@RegisteredNode("RPGPlayerBase")
export class RPGPlayerBase extends PlayerBase<RPGPlayerBaseState> {
  m_body: KinematicBody;
  camera: CameraNode;
  sprite: Sprite;

  constructor() {
    super();
    this.camera = new CameraNode();
    this.camera.setName("camera");
    this.camera.hardness = 5;
    this.add(this.camera);

    this.m_body = new KinematicBody();
    this.m_body.setName("body");
    this.add(this.m_body);

    this.setupSprite();

    this.controls.listenKey("R");

    this.controls.onKeyDown("W", () => {
      this.m_body.b2Body.SetLinearVelocity(
        new b2.Vec2(this.m_body.b2Body.GetLinearVelocity().x, -15)
      );
    });
    this.controls.onKeyDown("R", () => {
      this.fireBox();
    });
  }
  async setupSprite() {
    const sprite = new Sprite();
    sprite.setName("sprite");

    await sprite.loadSpriteSheet("https://i.ibb.co/NgZKwrj1/sonya-cat.png", {
      frameWidth: 32,
      frameHeight: 32,
    });
    sprite.anims.create({
      key: "idle",
      frames: Wired()
        .scene()
        .anims.generateFrameNames(sprite.texture.key, { start: 0, end: 3 }),
      frameRate: 8,
      repeat: 0,
    });
    sprite.anims.create({
      key: "walk",
      frames: Wired()
        .scene()
        .anims.generateFrameNames(sprite.texture.key, { start: 4, end: 7 }),
      frameRate: 8,
      repeat: -1,
    });

    this.m_body.add(sprite);
    this.sprite = sprite;
    sprite.setScale(sprite.scale * 2);
    sprite.y = -0.5;

    sprite.play("walk", true);
  }
  fireBox() {
    if (!Wired().network.isServer) return;
    const body = new RigidBody();
    Wired().scene().worldNode.add(body);
    body.b2Body.SetLinearVelocity(
      new b2.Vec2(this.m_body.b2Body.GetLinearVelocity().x, -20)
    );
    body.broadcast();
  }
  addedToScene() {
    if (this.isLocal()) {
      this.camera.setMainCamera();
      this.camera.setTarget(this.m_body);
    }
  }
  onNodeStateChanged(
    oldState: RPGPlayerBaseState,
    state: RPGPlayerBaseState
  ): void {}
  update(time: number, delta: number): void {
    super.update(time, delta);
    const speed = 5;
    const movement = new b2.Vec2(0, 0);

    if (this.controls.isKeyDown("D")) {
      movement.x += speed;
      if (this.sprite) this.sprite.flipX = false;
    }
    if (this.controls.isKeyDown("A")) {
      movement.x -= speed;
      if (this.sprite) this.sprite.flipX = true;
    }
    if (this.controls.isKeyDown("A") || this.controls.isKeyDown("D")) {
      if (this.sprite.anims.currentAnim.key != "walk") {
        this.sprite.play("walk", true);
      }
    } else {
      if (this.sprite) {
        if (this.sprite.anims.currentAnim.key != "idle") {
          this.sprite.play("idle", true);
        }
      }
    }
    movement.y = this.m_body.b2Body.GetLinearVelocity().y;
    this.m_body.b2Body.SetLinearVelocity(movement);
  }
}

export function init() {
  Wired().scene().registerPlayerClass("RPGPlayerBase");
}

export function unload() {
  console.log("UNLOADDDDING");
}
