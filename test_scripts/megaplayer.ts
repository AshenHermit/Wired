import {
  RegisteredNode,
  KinematicBody,
  PlayerBase,
  PlayerBaseState,
  Sprite,
  Wired,
} from "@wired-io";
import * as b2 from "@box2d";

type PlayerState = PlayerBaseState & {};

@RegisteredNode("MegaPlayer")
export class MegaPlayer extends PlayerBase<PlayerState> {
  m_body: KinematicBody;

  constructor() {
    super();
    super.addedToScene();
    this.m_body = new KinematicBody();
    this.m_body.setName("body");
    this.add(this.m_body);
    const sprite = new Sprite(
      "https://i.pinimg.com/736x/6d/4a/4e/6d4a4e011676f8cc2678411c30fb4ab2.jpg"
    );
    sprite.setName("sprite");
    this.m_body.add(sprite);

    this.controls.onKeyDown("W", () => {
      this.m_body.b2Body.SetLinearVelocity(
        new b2.Vec2(this.m_body.b2Body.GetLinearVelocity().x, -5)
      );
    });
  }
  update(time: number, delta: number): void {
    super.update(time, delta);
    const speed = 2;
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

export function init() {
  Wired().scene().registerPlayerClass("MegaPlayer");
}
