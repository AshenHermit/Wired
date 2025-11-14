import { RegisteredNode } from "../NodesRegistry";
import { SceneReplicator } from "../SceneReplicator";
import { Wired } from "../WiredGlobal";
import { Node, Rpc } from "./Node";

@RegisteredNode("SceneReplicatorNode")
export class SceneReplicatorNode extends Node {
  replicator: SceneReplicator;
  constructor() {
    super();
    this.replicator = new SceneReplicator(Wired().scene());
  }

  async sendSyncToClient(socketId: string) {
    const snapshot = this.getTreeSnapshot();
    this.rpcId(this.recieveSnapshot, socketId, snapshot);
  }
  async sendSyncToAll() {
    const snapshot = this.getTreeSnapshot();
    this.rpc(this.recieveSnapshot, snapshot);
  }

  @Rpc("client")
  async recieveSnapshot(snapshot) {
    for (const item of snapshot) {
      this.replicator.create(item);
    }
  }
}
