import { GameScene } from "./GameScene";
import { getNodeCtor } from "./NodesRegistry";
import { NodeTreeSnapshotItem } from "./objects";

export type NodePayload = NodeTreeSnapshotItem;

export class SceneReplicator {
  constructor(private scene: GameScene) {}

  upsert(payload: NodePayload) {
    const node = this.scene.findByPath(payload.path);
    if (node) {
      this.update(payload);
    } else {
      this.create(payload);
    }
  }

  create(payload: NodePayload) {
    const ctor = getNodeCtor(payload.class);
    if (!ctor) return;

    const parent = this.scene.ensureParent(payload.path);
    if (!parent) return;

    const node = new ctor();
    node.setName(payload.path.split("/").pop()!);
    if (payload.state) node.setNodeState(payload.state);
    // this.applyTransform(node, payload.transform);
    parent.add(node);
  }

  update(payload: NodePayload) {
    const node = this.scene.findByPath(payload.path);
    if (!node) return;

    if (payload.state) {
      // choose your policy: full replace or deep merge
      node.setNodeState({ ...node.getNodeState(), ...payload.state });
    }
    // this.applyTransform(node, payload.transform);
  }

  remove(payload: NodePayload) {
    const node = this.scene.findByPath(payload.path);
    if (!node) return;

    node.destroy();
  }
}
