import * as Phaser from "phaser";
import { NetworkAPIBase } from "../networking";

export interface RoomPlayerData {
  id: number;
  socketId: string;
}

export interface GameRoomData {
  id: number;
  name: string;
  players: RoomPlayerData[];
}

export interface GameRoomRuntime {
  networkApi: NetworkAPIBase;
  game: Phaser.Game;
  component?: {
    instanceId: string;
    mounted: boolean;
    unmount: () => void;
  };
}
