import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Sprite } from "./Sprite";
import { Node } from "./Node";
import { RegisteredNode } from "../NodesRegistry";
import { PlayerBase, PlayerBaseState } from "./PlayerBase";
import * as b2 from "@box2d";

export type KinematicBodyState = {
  time: number;
  x?: number;
  y?: number;
  linearVelocity?: { x: number; y: number };
  angle?: number;
};

@RegisteredNode("KinematicBody")
export class KinematicBody extends Node<KinematicBodyState> {}
