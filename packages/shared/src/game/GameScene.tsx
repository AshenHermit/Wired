import * as Phaser from "phaser";
import { asNode, Node, TestPlayer, SceneReplicatorNode } from "./objects";
import { SceneReplicator } from "./SceneReplicator";
import { Wired } from "./WiredGlobal";
import { PlayersManagerNode } from "./objects/PlayersManagerNode";
import { ScriptsManagerNode } from "./objects/ScriptsManagerNode";
import { World, Vec2 } from "@box2d";
import { CalculateParticleIterations } from "@box2d";
import * as b2 from "@box2d";
import { Camera, DebugDraw, g_camera, g_debugDraw } from "./utils/b2DebugDraw";
import { NetworkMetricsNode } from "./objects/NetworkMetrics";
export class GameScene extends Phaser.Scene {
  isSceneReady = false;
  worldNode?: Node;
  playersManagerNode?: PlayersManagerNode;
  scriptsManagerNode?: ScriptsManagerNode;
  networkMetricsNode?: NetworkMetricsNode;
  nextNodeId = 0;
  b2dWorld: World;
  g_debugDraw: DebugDraw;
  g_camera: Camera;

  elapsedTime = 0;
  fixedTimeStep = 1000 / 60;

  constructor() {
    super({
      key: "GameScene",
    });
    // Создаем Box2D мир с гравитацией (0, 0) - можно настроить позже
    this.b2dWorld = new World(new Vec2(0, 10));
    this.b2dWorld.SetDebugDraw(g_debugDraw);
    this.g_debugDraw = g_debugDraw;
    this.g_camera = g_camera;
    this.g_debugDraw.SetFlags(b2.DrawFlags.e_all);

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

    shape.SetTwoSided(new b2.Vec2(0.0, 5.0), new b2.Vec2(5.0, 3.0));
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

    this.networkMetricsNode = new NetworkMetricsNode();
    this.networkMetricsNode.setName("networkMetrics");
    this.worldNode.add(this.networkMetricsNode);

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

    if (this.g_debugDraw.m_ctx) {
      this.g_camera.m_width = this.game.canvas.width;
      this.g_camera.m_height = this.game.canvas.height;
      this.g_camera.m_center.x =
        this.cameras.main.centerX - this.g_camera.m_width / 2;
      this.g_camera.m_center.y =
        this.cameras.main.centerY - this.g_camera.m_height / 2;
      this.g_camera.m_zoom = 1 / this.cameras.main.zoom;

      this.g_camera.m_extent = this.g_camera.m_height / 2;

      let ctx = this.g_debugDraw.m_ctx;
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

      // ctx.strokeStyle = "blue";
      // ctx.strokeRect(this.m_mouse.x - 24, this.m_mouse.y - 24, 48, 48);

      // const mouse_world: b2.Vec2 = g_camera.ConvertScreenToWorld(this.m_mouse, new b2.Vec2());

      ctx.save();

      // 0,0 at center of canvas, x right, y up
      ctx.translate(0.5 * ctx.canvas.width, 0.5 * ctx.canvas.height);
      ctx.scale(1, 1);
      ///ctx.scale(g_camera.m_extent, g_camera.m_extent);
      ///ctx.lineWidth /= g_camera.m_extent;
      const s: number = (0.5 * g_camera.m_height) / g_camera.m_extent;
      ctx.scale(s, s);
      ctx.lineWidth /= s;

      // apply camera
      ctx.scale(1 / g_camera.m_zoom, 1 / g_camera.m_zoom);
      ctx.lineWidth *= g_camera.m_zoom;
      ///ctx.rotate(-g_camera.m_roll.GetAngle());
      ctx.translate(-g_camera.m_center.x, -g_camera.m_center.y);
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
    this.b2dWorld.DebugDraw();
    super.update(time, delta);
    for (const node of this.sys.updateList.getActive()) {
      node.update(time, delta);
    }

    if (this.g_debugDraw.m_ctx) {
      this.g_debugDraw.m_ctx.restore();
    }
  }
}

export class TestGameScene extends GameScene {
  onSceneReady(): void {
    super.onSceneReady();
  }
}
