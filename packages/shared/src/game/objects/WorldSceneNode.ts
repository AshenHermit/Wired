import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Node, NodeTreeSnapshot, NodeTreeSnapshotItem, Rpc } from "./Node";
import { RegisteredNode } from "../NodesRegistry";

export type WorldSceneNodeState = {
  snapshot: NodeTreeSnapshot;
};

@RegisteredNode("WorldSceneNodeNode")
export class WorldSceneNodeNode extends Node<WorldSceneNodeState> {
  constructor() {
    super();
  }
}
