import * as Phaser from 'phaser';
import { Injectable } from '@nestjs/common';
import { GameRoomData } from '@wired-io/shared';
import { NetworkAPI } from './NetworkAPI';
import { Server } from 'socket.io';
import { WiredInstance } from './WiredInstance';

export class GameRoomRuntime {
  private playerIdCounter = 0;
  constructor(
    public readonly roomData: GameRoomData,
    public readonly network: NetworkAPI,
    public readonly wiredInstance: WiredInstance,
  ) {}
  fetchPlayerId() {
    return this.playerIdCounter++;
  }
  setup() {
    this.wiredInstance.setup();
  }
  addPlayer(socketId: string) {
    const player = this.roomData.players.find(
      (player) => player.socketId === socketId,
    );
    if (player) {
      return player;
    }
    const newplayer = {
      id: this.fetchPlayerId(),
      socketId: socketId,
    };
    this.roomData.players.push(newplayer);
    this.wiredInstance.connectPlayer(socketId);
    return newplayer;
  }
  removePlayer(socketId: string) {
    this.roomData.players = this.roomData.players.filter(
      (player) => player.socketId !== socketId,
    );
    this.wiredInstance.disconnectPlayer(socketId);
  }
}

@Injectable()
export class GameRoomsService {
  private readonly gameRoomsRuntimes: Map<string, GameRoomRuntime> = new Map();

  constructor() {
    globalThis.SERVER_ENV = true;
  }

  getRoom(roomId: number): GameRoomRuntime | undefined {
    return this.gameRoomsRuntimes.get(roomId.toString());
  }

  getRoomByPeer(socketId: string): GameRoomRuntime | undefined {
    return Array.from(this.gameRoomsRuntimes.values()).find((room) =>
      room.roomData.players.some((player) => player.socketId === socketId),
    );
  }

  async createGameRoom(
    roomId: number,
    socket: Server,
  ): Promise<GameRoomRuntime> {
    const room: GameRoomData = {
      id: roomId,
      name: `Game Room ${roomId}`,
      players: [],
    };
    const api = new NetworkAPI();
    api.setSocket(socket);
    const roomRuntime = new GameRoomRuntime(
      room,
      api,
      new WiredInstance({ network: api, displayParent: '' }),
    );
    api.setRoom(roomRuntime);
    this.gameRoomsRuntimes.set(roomId.toString(), roomRuntime);
    roomRuntime.setup();
    return roomRuntime;
  }
}
