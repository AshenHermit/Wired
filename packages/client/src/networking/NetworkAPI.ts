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
  backendUrl: string = "http://localhost:3000";
  events = new EventEmitter<NetworkEvents>();

  constructor(url: string, backendUrl: string) {
    super();
    this.isServer = false;
    this.roomEventHandlers.set("rpc", this.onRpcEvent.bind(this));
    this.url = url;
    this.backendUrl = backendUrl;
  }

  connect(): void {
    // Socket.IO клиент работает с wss:// URL напрямую
    // Используем URL как есть, Socket.IO автоматически определит протокол WebSocket
    this.socket = io(this.url, {
      transports: ["websocket"],
      upgrade: false, // Отключаем upgrade, используем только WebSocket
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      forceNew: true,
    });

    this.socket.on("connect", () => {
      this.connected = true;
      console.log("Connected to game server at", this.url);
      this.events.emit("connected", undefined);
    });

    this.socket.on("disconnect", () => {
      this.connected = false;
      console.log("Disconnected from game server");
      this.events.emit("disconnected", undefined);
    });

    this.socket.on("room_events", async (data) => {
      if (this.throttling > 0)
        await new Promise((resolve) => setTimeout(resolve, this.throttling));
      this.onRoomEvent(data.event, data.data, "0");
    });

    this.socket.on("connect_error", (error) => {
      console.error("WebSocket connection error:", error);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
    }
  }

  async emit<T>(event: string, data: any): Promise<T> {
    if (this.throttling > 0)
      await new Promise((resolve) => setTimeout(resolve, this.throttling));
    return await new Promise((resolve, reject) => {
      this.socket?.emit(event, data, (response: T) => {
        resolve(response);
      });
    });
  }
  async emitTo<T>(event: string, data: any, to: string): Promise<T> {
    if (this.throttling > 0)
      await new Promise((resolve) => setTimeout(resolve, this.throttling));
    return Promise.resolve(data as T);
  }

  async onRpcEvent(data: RPCInfo, socketId: string) {
    const node = Wired().scene().findByPath(data.nodePath);
    if (node) {
      const method = (node as any)[data.methodName];
      if (method && typeof method === "function") {
        return await node.callRpc(method, ...data.args);
      }
    }
    return null;
  }
}
