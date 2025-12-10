import * as Phaser from "phaser";
import { asNode, Node, TestPlayer, SceneReplicatorNode } from "./objects";
import { SceneReplicator } from "./SceneReplicator";
import { Wired } from "./WiredGlobal";
import { PlayersManagerNode } from "./objects/PlayersManagerNode";
import { ScriptsManagerNode } from "./objects/ScriptsManagerNode";
import { World, Vec2 } from "@box2d";
import { CalculateParticleIterations } from "@box2d";
import * as b2 from "@box2d";
export class GameScene extends Phaser.Scene {
  isSceneReady = false;
  worldNode?: Node;
  playersManagerNode?: PlayersManagerNode;
  scriptsManagerNode?: ScriptsManagerNode;
  nextNodeId = 0;
  b2dWorld: World;

  elapsedTime = 0;
  fixedTimeStep = 1000 / 60;

  constructor() {
    super({
      key: "GameScene",
    });
    // Создаем Box2D мир с гравитацией (0, 0) - можно настроить позже
    this.b2dWorld = new World(new Vec2(0, 10));
    const bd = new b2.BodyDef();
    const ground = this.b2dWorld.CreateBody(bd);

    const shape = new b2.EdgeShape();
    shape.SetTwoSided(new b2.Vec2(-40.0, 5.0), new b2.Vec2(40.0, 5.0));
    ground.CreateFixture(shape, 0.0);

    shape.SetTwoSided(new b2.Vec2(-40.0, -5.0), new b2.Vec2(40.0, -5.0));
    ground.CreateFixture(shape, 0.0);

    shape.SetTwoSided(new b2.Vec2(5.0, -5.0), new b2.Vec2(5.0, 5.0));
    ground.CreateFixture(shape, 0.0);

    shape.SetTwoSided(new b2.Vec2(-5.0, -5.0), new b2.Vec2(-5.0, 5.0));
    ground.CreateFixture(shape, 0.0);
  }

  getNextNodeName() {
    return `node-${this.nextNodeId++}`;
  }

  findByPath(path: string): Node | null {
    if (!this.worldNode) return null;
    const segments = path.split("/").filter(Boolean);
    let cur: Phaser.GameObjects.Container = this.worldNode;
    if (segments[0] !== this.worldNode.name) return null;

    for (let i = 1; i < segments.length; i++) {
      const nextName = segments[i];
      const next = cur.getAll().find((ch) => asNode(ch)?.name === nextName);
      if (!next) return null;
      cur = next as Phaser.GameObjects.Container;
    }
    return asNode(cur);
  }

  ensureParent(path: string): Node | null {
    const parentPath = path.split("/").slice(0, -1).join("/");
    return this.findByPath(parentPath);
  }

  registerPlayerClass(playerClass: string) {
    this.playersManagerNode?.registerPlayerClass(playerClass);
  }

  onSceneReady() {
    this.worldNode = new Node();
    this.worldNode.setName("root");
    this.add.existing(this.worldNode);

    this.scriptsManagerNode = new ScriptsManagerNode();
    this.scriptsManagerNode.setName("scripts");
    this.worldNode.add(this.scriptsManagerNode);

    this.playersManagerNode = new PlayersManagerNode();
    this.playersManagerNode.setName("players");
    this.worldNode.add(this.playersManagerNode);
    this.cameras.main.centerOn(0, 0);
    this.cameras.main.zoom = 50;
  }
  update(time: number, delta: number): void {
    if (!this.isSceneReady) {
      this.onSceneReady();
      Wired().events.emit("sceneReady", undefined);
      this.isSceneReady = true;
    }
    this.elapsedTime += delta;
    while (this.elapsedTime >= this.fixedTimeStep) {
      this.elapsedTime -= this.fixedTimeStep;
      this.b2dWorld.Step(
        1 / 60,
        8,
        3,
        CalculateParticleIterations(10, 0.04, 1 / 60)
      );
      this.b2dWorld.Step(
        1 / 60,
        8,
        3,
        CalculateParticleIterations(10, 0.04, 1 / 60)
      );
    }
    super.update(time, delta);
  }
}

export class TestGameScene extends GameScene {
  onSceneReady(): void {
    super.onSceneReady();
  }
}
