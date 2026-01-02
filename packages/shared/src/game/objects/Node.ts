import * as Phaser from "phaser";
import { Wired, WiredGlobal } from "../WiredGlobal";
import { RegisteredNode } from "../NodesRegistry";
import { RPCInfo } from "../../networking";
import { SceneReplicator } from "../SceneReplicator";
import { FunctionDeclaration } from "typescript";

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
export type NodeTreeSnapshot = NodeTreeSnapshotItem[];

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
  storeNodeState(state: Partial<S>) {
    this.setData("state", { ...this.getNodeState(), ...state });
  }
  setNodeState(state: Partial<S>) {
    const oldState = this.getNodeState();
    this.setData("state", { ...oldState, ...state });
    this.onNodeStateChanged(oldState, this.getNodeState());
  }
  broadcastNodeState(state: Partial<S>, set: boolean = true) {
    const oldState = this.getNodeState();
    this.setData("state", { ...oldState, ...state });
    if (set) this.onNodeStateChanged(oldState, this.getNodeState());
    this.broadcastSingle();
    if (!set) this.setData("state", { ...oldState });
  }

  preUpdate(time: number, delta: number): void {}
  update(time: number, delta: number): void {
    super.update(time, delta);
  }

  onNodeStateChanged(oldState: S, state: S) {}

  getPath(): string {
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
    const snapshot: NodeTreeSnapshot = [
      {
        path: this.getPath(),
        name: this.name,
        class: this.constructor.prototype.className || this.constructor.name,
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
  removedFromScene(): void {
    super.removedFromScene();
  }

  async rpc<T extends (...args: any) => any>(func: T, ...args: Parameters<T>) {
    if ((func as any).isRPC) {
      const rpcObj = func.apply(this, args) as RpcObject;
      return await rpcObj.rpc();
    }
    return null;
  }
  async rpcId<T extends (...args: any) => any>(
    func: T,
    id?: string,
    ...args: Parameters<T>
  ) {
    if ((func as any).isRPC) {
      const rpcObj = func.apply(this, args) as RpcObject;
      return await rpcObj.rpcId(id);
    }
    return null;
  }
  async callRpc<T extends (...args: any) => any>(
    func: T,
    ...args: Parameters<T>
  ) {
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
      await parent.rpc(parent.recieveSnapshot, [snapshot]);
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
  async recieveSnapshot(snapshot: NodeTreeSnapshot) {
    const replicator = new SceneReplicator(Wired().scene());
    for (const item of snapshot) {
      replicator.upsert(item);
    }
  }

  @Rpc("client")
  async recieveDestroySnapshot(snapshot: NodeTreeSnapshot) {
    const replicator = new SceneReplicator(Wired().scene());
    for (const item of snapshot) {
      replicator.remove(item);
    }
  }

  async serverRecreateNode(className?: string): Promise<Node | null> {
    const snapshot = this.getTreeSnapshot();
    if (className) {
      snapshot[0].class = className;
    }
    await this.broadcastDestroy();

    const replicator = new SceneReplicator(Wired().scene());
    const nodes: Node[] = [];
    for (const item of snapshot) {
      replicator.upsert(item);
      const node = Wired().scene().findByPath(item.path);
      if (node) nodes.push(node);
    }

    if (nodes.length > 0) {
      await nodes[0].broadcast();
      return nodes[0];
    }
    return null;
  }
}
