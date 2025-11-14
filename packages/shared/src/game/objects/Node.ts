import * as Phaser from "phaser";
import { Wired, WiredGlobal } from "../WiredGlobal";
import { RegisteredNode } from "../NodesRegistry";
import { RPCInfo } from "../../networking";
import { SceneReplicator } from "../SceneReplicator";

export function asNode(obj: any) {
  if (!obj) return null;
  if (obj.IS_NODE) return obj as Node;
  return null;
}

export interface NodeTreeSnapshotItem {
  path: string;
  name: string;
  class: string;
  state: any;
}

export type RpcObject = {
  originalMethod: Function;
  rpc: () => Promise<any>;
  rpcId: (id?: string) => Promise<any>;
};

export type RpcFlag = "callLocal" | "server" | "client";

export function Rpc(...flags: RpcFlag[]) {
  return function (
    target: Node,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    descriptor.value = function (this: Node, ...args: any[]) {
      const rpcInfo: RPCInfo = {
        toId: null,
        nodePath: this.getPath(),
        methodName: originalMethod.name,
        args: args,
      };
      return {
        originalMethod: originalMethod.bind(this),
        rpc: (async () => {
          if (flags.indexOf("callLocal") != -1) {
            originalMethod.apply(this, args);
          }
          return await this.ctx.network.roomRpcEmit(rpcInfo);
        }).bind(this),
        rpcId: (async (id: string) => {
          return await this.ctx.network.roomRpcEmit({ ...rpcInfo, toId: id });
        }).bind(this),
      };
    };
    descriptor.value.isRPC = true;
    return descriptor;
  };
}

export class Node<S extends Record<string, any> = {}> extends Phaser.GameObjects
  .Container {
  public IS_NODE = true;
  public ctx: WiredGlobal;

  constructor() {
    super(Wired().scene(), 0, 0);
    this.addToUpdateList();
    this.setName(Wired().scene().getNextNodeName());
    this.ctx = Wired();
  }
  getNodeState(): S {
    if (!this.getData("state")) this.setData("state", {});
    return this.getData("state") as S;
  }
  setupNodeState(state: S) {
    this.setData("state", state);
  }
  setNodeState(state: Partial<S>, broadcast: boolean = true) {
    this.setData("state", { ...this.getNodeState(), ...state });
    this.onNodeStateChanged(this.getNodeState());
    if (broadcast) {
      this.broadcastSingle();
    }
  }

  onNodeStateChanged(state: S) {}

  getPath() {
    const parent = this.getParentNode();
    if (parent) {
      return `${parent.getPath()}/${this.name}`;
    }
    return this.name;
  }
  getParentNode() {
    return asNode(this.parentContainer);
  }
  getTreeSnapshot() {
    const snapshot: NodeTreeSnapshotItem[] = [
      {
        path: this.getPath(),
        name: this.name,
        class: this.constructor.name,
        state: this.getNodeState(),
      },
    ];
    for (const child of this.getAll()) {
      const node = asNode(child);
      if (node) {
        snapshot.push(...node.getTreeSnapshot());
      }
    }
    return snapshot;
  }
  addedToScene(): void {
    super.addedToScene();
  }

  async rpc(func: Function, ...args: any[]) {
    if ((func as any).isRPC) {
      const rpcObj = func.apply(this, args) as RpcObject;
      return await rpcObj.rpc();
    }
    return null;
  }
  async rpcId(func: Function, id?: string, ...args: any[]) {
    if ((func as any).isRPC) {
      const rpcObj = func.apply(this, args) as RpcObject;
      return await rpcObj.rpcId(id);
    }
    return null;
  }
  async callRpc(func: Function, ...args: any[]) {
    if ((func as any).isRPC) {
      const rpcObj = func.apply(this, args) as RpcObject;
      return await rpcObj.originalMethod(...args);
    }
    return null;
  }

  @Rpc("server")
  async serverBroadcastSingle(snapshot: NodeTreeSnapshotItem) {
    this.callRpc(this.recieveSnapshot, [snapshot]);
    this.rpc(this.recieveSnapshot, [snapshot]);
  }

  async broadcastSingle() {
    const parent = this.getParentNode();
    if (parent) {
      if (!Wired().network.isServer) {
        const snapshot = this.getTreeSnapshot()[0];
        return await parent.rpc(parent.serverBroadcastSingle, snapshot);
      }
      const snapshot = this.getTreeSnapshot()[0];
      await parent.rpc(parent.recieveSnapshot, snapshot);
    }
  }

  async broadcast() {
    if (!Wired().network.isServer) return;
    const parent = this.getParentNode();
    if (parent) {
      const snapshot = this.getTreeSnapshot();
      await parent.rpc(parent.recieveSnapshot, snapshot);
    }
  }

  async broadcastDestroy() {
    if (!Wired().network.isServer) return;
    const parent = this.getParentNode();
    if (parent) {
      const snapshot = this.getTreeSnapshot();
      await parent.rpc(parent.recieveDestroySnapshot, snapshot);
    }
    this.destroy(true);
  }

  @Rpc("client")
  async recieveSnapshot(snapshot: NodeTreeSnapshotItem[]) {
    const replicator = new SceneReplicator(Wired().scene());
    for (const item of snapshot) {
      replicator.upsert(item);
    }
  }

  @Rpc("client")
  async recieveDestroySnapshot(snapshot: NodeTreeSnapshotItem[]) {
    const replicator = new SceneReplicator(Wired().scene());
    for (const item of snapshot) {
      replicator.remove(item);
    }
  }
}
