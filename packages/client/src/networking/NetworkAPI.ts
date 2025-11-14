import { io, Socket } from "socket.io-client";
import {
  NetworkAPIBase,
  NetworkEvents,
  RPCInfo,
  Wired,
} from "@wired-io/shared";
import EventEmitter from "easy-event-emitter";

export class NetworkAPI extends NetworkAPIBase {
  socket: Socket | null = null;
  connected: boolean = false;
  url: string = "http://localhost:3000";
  events = new EventEmitter<NetworkEvents>();

  constructor() {
    super();
    this.isServer = false;
    this.roomEventHandlers.set("rpc", this.onRpcEvent.bind(this));
  }

  connect(): void {
    this.socket = io(this.url);

    this.socket.on("connect", () => {
      this.connected = true;
      console.log("Connected to game server");
      this.events.emit("connected", undefined);
    });

    this.socket.on("disconnect", () => {
      this.connected = false;
      console.log("Disconnected from game server");
      this.events.emit("disconnected", undefined);
    });

    this.socket.on("room_events", (data) => {
      this.onRoomEvent(data.event, data.data, "0");
    });

    this.socket.on("connect_error", (error) => {});
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
    }
  }

  emit<T>(event: string, data: any): Promise<T> {
    return new Promise((resolve, reject) => {
      this.socket?.emit(event, data, (response: T) => {
        resolve(response);
      });
    });
  }
  emitTo<T>(event: string, data: any, to: string): Promise<T> {
    return;
  }

  async onRpcEvent(data: RPCInfo, socketId: string) {
    const node = Wired().scene().findByPath(data.nodePath);
    if (node) {
      return await node.callRpc(node[data.methodName], ...data.args);
    }
    return null;
  }
}
