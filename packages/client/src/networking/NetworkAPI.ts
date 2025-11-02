import { io, Socket } from "socket.io-client";
import { NetworkAPIBase } from "@wired-io/shared";

export class NetworkAPI implements NetworkAPIBase {
  socket: Socket | null = null;
  connected: boolean = false;
  url: string = "http://localhost:3000";

  constructor() {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(this.url);

      this.socket.on("connect", () => {
        this.connected = true;
        console.log("Connected to game server");
        resolve();
      });

      this.socket.on("disconnect", () => {
        this.connected = false;
        console.log("Disconnected from game server");
      });

      this.socket.on("connect_error", (error) => {
        reject(error);
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
    }
  }

  emitAsync<T>(event: string, data: any): Promise<T> {
    return new Promise((resolve, reject) => {
      this.socket?.emit(event, data, (response: T) => {
        resolve(response);
      });
    });
  }

  async connectToRoom(roomId: number): Promise<void> {
    const room = await this.emitAsync("connectToRoom", { roomId });
    console.log(room);
  }
}
