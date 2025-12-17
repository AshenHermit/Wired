import { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameRoomsService } from 'src/game/game-rooms.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnApplicationBootstrap
{
  @WebSocketServer()
  server: Server;

  constructor(private readonly gameRoomsService: GameRoomsService) {}

  onApplicationBootstrap() {
    this.gameRoomsService.setupServer(this.server);
  }

  handleConnection(client: Socket, ...args: any[]) {
    console.log(`Client connected: ${client.id}`);
  }
  handleDisconnect(client: Socket): void {
    const room = this.gameRoomsService.getRoomByPeer(client.id);
    if (room) room.removePlayer(client.id);
    console.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('identity')
  async identity(
    @MessageBody() data: string,
    @ConnectedSocket() client: Socket,
  ): Promise<string> {
    return data;
  }

  @SubscribeMessage('connectToRoom')
  async connectToRoom(
    @MessageBody() data: { roomId: number },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.gameRoomsService.getRoom(data.roomId);
    if (!room) return null;
    room.addPlayer(client.id);
    return client.id;
  }

  @SubscribeMessage('disconnectFromRoom')
  async disconnectFromRoom(
    @MessageBody() data: { roomId: number },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.gameRoomsService.getRoom(data.roomId);
    if (!room) return null;
    room.removePlayer(client.id);
    return client.id;
  }

  @SubscribeMessage('room_events')
  async roomEvents(
    @MessageBody() data: { event: string; data: any },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.gameRoomsService.getRoomByPeer(client.id);
    if (!room) return null;
    return await room.network.onRoomEvent(data.event, data.data, client.id);
  }
}
