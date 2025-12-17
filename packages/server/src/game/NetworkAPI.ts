import {
  _setupWiredGlobal,
  BroadcastResult,
  NetworkAPIBase,
  NetworkEvents,
  RPCInfo,
  Wired,
} from '@wired-io/shared';
import EventEmitter from 'easy-event-emitter';
import { Server, Socket } from 'socket.io';
import { GameRoomRuntime } from './game-rooms.service';

export type RoomEventHandler = (data: any, socketId: string) => Promise<any>;

export class NetworkAPI extends NetworkAPIBase {
  socket: Server | null = null;
  connected: boolean = false;
  url: string = 'http://localhost:3000';
  events = new EventEmitter<NetworkEvents>();
  roomRuntime: GameRoomRuntime;

  constructor() {
    super();
    this.isServer = true;
    this.roomEventHandlers.set('rpc', this.onRpcEvent.bind(this));
  }

  setSocket(socket: Server) {
    this.socket = socket;
  }
  setRoom(roomRuntime: GameRoomRuntime) {
    this.roomRuntime = roomRuntime;
  }

  async onRpcEvent(data: RPCInfo, socketId: string) {
    _setupWiredGlobal(this.roomRuntime.wiredInstance.wiredGlobal!);
    const node = Wired().scene().findByPath(data.nodePath);
    this.lastRecievedSocketId = socketId;
    if (node) {
      return await node.callRpc(node[data.methodName], ...data.args);
    }
    return null;
  }

  connect(): void {}

  disconnect(): void {}

  async emit<T>(event: string, data: any): Promise<T> {
    const results: BroadcastResult = [];
    if (this.socket) {
      const players = this.roomRuntime.roomData.players;
      for (const player of players) {
        const res = this.emitTo(event, data, player.socketId);
        results.push({
          result: res,
          socketId: player.socketId,
        });
      }
    }
    return results as T;
  }
  async emitTo<T>(event: string, data: any, to: string) {
    if (this.socket) {
      const socket = this.socket.sockets.sockets.get(to);
      if (socket) {
        try {
          return await socket.timeout(1000).emitWithAck(event, data);
        } catch (err) {}
      }
    }
    return null as T;
  }
}
