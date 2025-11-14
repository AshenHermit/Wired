import * as Phaser from "phaser";
import { asNode, Node, Player, SceneReplicatorNode } from "./objects";
import { SceneReplicator } from "./SceneReplicator";
import { Wired } from "./WiredGlobal";
import { PlayersManagerNode } from "./objects/PlayersManagerNode";
import { ScriptsManagerNode } from "./objects/ScriptsManagerNode";

export class GameScene extends Phaser.Scene {
  isSceneReady = false;
  worldNode?: Node;
  playersManagerNode?: PlayersManagerNode;
  scriptsManagerNode?: ScriptsManagerNode;
  nextNodeId = 0;

  constructor() {
    super({
      key: "GameScene",
    });
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

  onSceneReady() {
    this.worldNode = new Node();
    this.worldNode.setName("root");
    this.add.existing(this.worldNode);

    this.playersManagerNode = new PlayersManagerNode();
    this.playersManagerNode.setName("players");
    this.worldNode.add(this.playersManagerNode);

    this.scriptsManagerNode = new ScriptsManagerNode();
    this.scriptsManagerNode.setName("scripts");
    this.worldNode.add(this.scriptsManagerNode);
  }
  update(time: number, delta: number): void {
    if (!this.isSceneReady) {
      this.onSceneReady();
      Wired().events.emit("sceneReady", undefined);
      this.isSceneReady = true;
    }
    super.update(time, delta);
  }
}

export class TestGameScene extends GameScene {
  onSceneReady(): void {
    super.onSceneReady();
  }
}
