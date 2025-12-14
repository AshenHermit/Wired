import EventEmitter from "easy-event-emitter";

export type NetworkEvents = {
  connected: void;
  disconnected: void;
};

export type RPCInfo = {
  toId: string | null;
  nodePath: string;
  methodName: string;
  args: any[];
};

export type RoomEventHandler = (data: any, socketId: string) => Promise<any>;

export type BroadcastResultItem = {
  socketId: string;
  result: Promise<any>;
};
export type BroadcastResult = BroadcastResultItem[];

export class NetworkAPIBase {
  connected: boolean = false;
  url: string = "";
  roomEventHandlers: Map<string, RoomEventHandler> = new Map();
  isServer = false;
  localId: string = "0";

  connect(): void {}

  disconnect(): void {}

  emit<T>(event: string, data: any): Promise<T> {
    return Promise.resolve(data as T);
  }
  emitTo<T>(event: string, data: any, to: string): Promise<T> {
    return Promise.resolve(data as T);
  }

  async roomEmit<T>(event: string, data: any): Promise<T> {
    return await this.emit("room_events", { event, data });
  }
  async roomEmitTo<T>(event: string, data: any, to: string): Promise<T> {
    return await this.emitTo("room_events", { event, data }, to);
  }

  async roomRpcEmit<T>(rpcInfo: RPCInfo): Promise<T> {
    if (rpcInfo.toId) {
      return await this.roomEmitTo("rpc", rpcInfo, rpcInfo.toId);
    }
    return await this.roomEmit("rpc", rpcInfo);
  }

  async connectToRoom(roomId: number): Promise<string> {
    return await this.emit("connectToRoom", { roomId });
  }

  async onRoomEvent(event: string, data: any, socketId: string) {
    const handler = this.roomEventHandlers.get(event);
    if (handler) {
      return await handler(data, socketId);
    }
  }

  events!: EventEmitter<NetworkEvents>;
}
