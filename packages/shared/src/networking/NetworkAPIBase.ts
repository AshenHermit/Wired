export interface NetworkAPIBase {
  connected: boolean;
  url: string;

  connect(): Promise<void>;

  disconnect(): void;

  emitAsync<T>(event: string, data: any): Promise<T>;

  connectToRoom(roomId: number): Promise<void>;
}
