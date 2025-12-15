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
  idsCount = 0;
  lastRecievedId = -1;
  lastStateStat = { time: 0, id: -1 };
  latency = -1;
  stateInQueue: PlayerControlsState | null = null;
  syncTimer = 0.1;
  syncTimerTimeout = 20;
  keysQueue: { key: string; value: boolean }[] = [];
  staticState: PlayerControlsState = { keys: {}, id: -2 };

  constructor() {
    super();
    this.setNodeState({ keys: {}, id: -2 });
  }
  appendKeysInQueue(keys: Record<string, boolean>) {
    if (this.stateInQueue === null) {
      this.stateInQueue = { keys: this.getNodeState().keys, id: this.idsCount };
    }
    this.stateInQueue.keys = { ...this.stateInQueue.keys, ...keys };
  }
  listenKey(key: string) {
    const newKey = Wired().scene().input.keyboard?.addKey(key);
    if (newKey) this.keysRegistry[key] = newKey;
    newKey?.addListener(Phaser.Input.Keyboard.Events.DOWN, () => {
      if (!this.canListen) return;
      this.keysQueue.push({ key, value: true });
    });
    newKey?.addListener(Phaser.Input.Keyboard.Events.UP, () => {
      if (!this.canListen) return;
      this.keysQueue.push({ key, value: false });
    });
  }
  onNodeStateChanged(
    oldState: PlayerControlsState,
    state: PlayerControlsState
  ): void {
    if (this.canListen) return;
    for (const key in state.keys) {
      if (!oldState.keys[key] && state.keys[key]) {
        this.keyboardEvents.emit("onKeyDown", key);
      }
      if (oldState.keys[key] && !state.keys[key]) {
        this.keyboardEvents.emit("onKeyUp", key);
      }
    }
  }
  update(time: number, delta: number): void {
    if (this.canListen) {
      if (this.keysQueue.length > 0) {
        const key = this.keysQueue.shift();
        if (key) {
          this.staticState.keys[key.key] = key.value;
          this.staticState.id++;
          this.broadcastNodeState(
            { keys: this.staticState.keys, id: this.staticState.id },
            true
          );
          if (key.value) {
            this.keyboardEvents.emit("onKeyDown", key.key);
          } else {
            this.keyboardEvents.emit("onKeyUp", key.key);
          }
        }
      }
    }
  }
  isKeyUp(key: string) {
    return !this.getNodeState().keys[key];
  }
  isKeyDown(key: string) {
    return !!this.getNodeState().keys[key];
  }
  onKeyUp(key: string, cb: () => void) {
    this.keyboardEvents.addListener("onKeyUp", (eventKey) => {
      if (eventKey === key) cb();
    });
  }
  onKeyDown(key: string, cb: () => void) {
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
