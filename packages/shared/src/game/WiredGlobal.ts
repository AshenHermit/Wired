import EventEmitter from "easy-event-emitter";
import { NetworkAPIBase } from "../networking";
import { GameScene } from "./GameScene";
import { fetchTexture, TextureLoadData } from "./utils";
import { WiredInstanceEvents } from "./WiredInstance";

declare global {
  var Wired: WiredGlobal | undefined;
}

export interface WiredGlobalBase {
  game: () => Phaser.Game | null;
  network: NetworkAPIBase;
  scene: () => GameScene;
  events: EventEmitter<WiredInstanceEvents>;
}

export interface WiredGlobal extends WiredGlobalBase {
  fetchTexture: (url: string, cb: (data: TextureLoadData) => void) => void;
}

export function Wired(): WiredGlobal {
  if (globalThis.Wired) return globalThis.Wired as WiredGlobal;
  return {} as WiredGlobal;
}

export function _setupWiredGlobal(wired: WiredGlobal) {
  globalThis.Wired = wired;
}

export function createWiredGlobal(wired: WiredGlobalBase) {
  const wiredGlobal = wired as WiredGlobal;

  wiredGlobal.fetchTexture = (
    url: string,
    cb: (data: TextureLoadData) => void
  ) => {
    fetchTexture(wiredGlobal.scene(), url, wired.network).then(cb);
  };

  return wiredGlobal;
}
