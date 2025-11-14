export interface RoomPlayerData {
  id: number;
  socketId: string;
}

export interface GameRoomData {
  id: number;
  name: string;
  players: RoomPlayerData[];
}
