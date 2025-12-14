import EventEmitter from "easy-event-emitter";
import { NetworkAPIBase } from "../networking";
import {
  _setupWiredGlobal,
  createWiredGlobal,
  WiredGlobal,
} from "./WiredGlobal";
import { GameScene } from "./GameScene";

export interface WiredInstanceConfig {
  displayParent: string;
  network: NetworkAPIBase;
}

export type WiredInstanceState = "connecting" | "connected" | "disconnected";

export type WiredInstanceEvents = {
  stateChanged: WiredInstanceState;
  playerConnected: string;
  playerScriptsReady: string;
  playerDisconnected: string;
  sceneReady: void;
};

export abstract class WiredInstanceBase {
  public game: Phaser.Game | null = null;
  public config: WiredInstanceConfig;
  public network: NetworkAPIBase;
  public wiredGlobal?: WiredGlobal;

  public events = new EventEmitter<WiredInstanceEvents>();

  constructor(config: WiredInstanceConfig) {
    this.config = config;
    this.network = config.network;
  }

  setup() {}
  destroy() {}

  setupWiredGlobal() {
    this.wiredGlobal = createWiredGlobal({
      game: () => this.game,
      network: this.network,
      scene: () => this.game!.scene.getScene("GameScene") as GameScene,
      events: this.events,
    });
    _setupWiredGlobal(this.wiredGlobal);
  }
}
