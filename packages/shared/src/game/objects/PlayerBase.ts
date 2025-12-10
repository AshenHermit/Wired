import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Node } from "./Node";
import { RegisteredNode } from "../NodesRegistry";
import EventEmitter from "easy-event-emitter";

export type PlayerBaseState = {
  socketId: string;
};

export interface PlayerBaseInterface<
  TState extends PlayerBaseState = PlayerBaseState
> extends Node<TState> {
  isLocal(): boolean;
}

export type PlayerControlsState = {
  id: number;
  keys: Record<string, boolean>;
};
export type PlayerControlsEvents = {
  onKeyUp: string;
  onKeyDown: string;
};

export class PlayerControlsNode extends Node<PlayerControlsState> {
  keysRegistry: Record<string, Phaser.Input.Keyboard.Key> = {};
  keyboardEvents = new EventEmitter<PlayerControlsEvents>();
  canListen = false;
  idsCount = -1;
  lastRecievedId = -1;
  constructor() {
    super();
    this.setNodeState({ keys: {}, id: -2 });
  }
  listenKey(key: string) {
    const newKey = Wired().scene().input.keyboard?.addKey(key);
    if (newKey) this.keysRegistry[key] = newKey;
    newKey?.addListener(Phaser.Input.Keyboard.Events.DOWN, () => {
      if (!this.canListen) return;
      this.broadcastNodeState({
        keys: { ...this.getNodeState().keys, [key]: true },
        id: this.idsCount++,
      });
    });
    newKey?.addListener(Phaser.Input.Keyboard.Events.UP, () => {
      if (!this.canListen) return;
      this.broadcastNodeState({
        keys: { ...this.getNodeState().keys, [key]: false },
        id: this.idsCount++,
      });
    });
  }
  onNodeStateChanged(
    oldState: PlayerControlsState,
    state: PlayerControlsState
  ): void {
    if (state.id <= oldState.id) return;
    for (const key in state.keys) {
      if (!oldState.keys[key] && state.keys[key]) {
        this.keyboardEvents.emit("onKeyDown", key);
      }
      if (oldState.keys[key] && !state.keys[key]) {
        this.keyboardEvents.emit("onKeyUp", key);
      }
    }
  }
  isKeyUp(key) {
    return !this.getNodeState().keys[key];
  }
  isKeyDown(key) {
    return !!this.getNodeState().keys[key];
  }
  onKeyUp(key, cb: () => void) {
    this.keyboardEvents.addListener("onKeyUp", (eventKey) => {
      if (eventKey === key) cb();
    });
  }
  onKeyDown(key, cb: () => void) {
    this.keyboardEvents.addListener("onKeyDown", (eventKey) => {
      if (eventKey === key) cb();
    });
  }
}

@RegisteredNode("PlayerBase")
export class PlayerBase<TState extends PlayerBaseState>
  extends Node<TState>
  implements PlayerBaseInterface<TState>
{
  controls: PlayerControlsNode;

  constructor() {
    super();
    this.controls = new PlayerControlsNode();
    this.controls.setName("controls");
    this.add(this.controls);
    this.controls.listenKey("W");
    this.controls.listenKey("A");
    this.controls.listenKey("S");
    this.controls.listenKey("D");
  }
  addedToScene(): void {
    super.addedToScene();
  }
  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    this.controls.canListen = this.isLocal();
  }
  isLocal() {
    return Wired().network.localId == this.getNodeState().socketId;
  }
}
