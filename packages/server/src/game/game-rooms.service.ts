import { Injectable, Logger } from '@nestjs/common';
import { NetworkAPI } from './NetworkAPI';
import { Server } from 'socket.io';
import { WiredInstance } from './WiredInstance';
import { InjectRepository } from '@nestjs/typeorm';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import {
  RoomCreatedEvent,
  RoomDeletedEvent,
  RoomEvents,
  RoomUpdatedEvent,
} from 'src/events/room.events';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ScriptingPackageCreatedEvent,
  ScriptingPackageDeletedEvent,
  ScriptingPackageEvents,
  ScriptingPackageUpdatedEvent,
} from 'src/events/scripting-package.events';
import { instanceToPlain } from 'class-transformer';
import { ScriptingPackage as ScriptingPackageType } from '@wired-io/shared';

export interface RoomPlayerData {
  id: number;
  socketId: string;
}

export interface GameRoomData {
  id: number;
  name: string;
  players: RoomPlayerData[];
}

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

  private socket: Server | null = null;
  private logger: Logger = new Logger(GameRoomsService.name);

  constructor(
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(ScriptingPackage)
    private readonly scriptingPackagesRepository: Repository<ScriptingPackage>,
  ) {
    globalThis.SERVER_ENV = true;
  }

  getRoom(roomId: number): GameRoomRuntime | undefined {
    return this.gameRoomsRuntimes.get(roomId.toString());
  }

  removeRoom(roomId: number) {
    const room = this.getRoom(roomId);
    if (room) {
      this.gameRoomsRuntimes.delete(roomId.toString());
      room.wiredInstance.destroy();
      this.logger.log(`Game room ${roomId} removed`);
    }
  }

  updateRoom(roomId: number, roomEntity: Room) {
    const room = this.getRoom(roomId);
    if (room) {
      room.roomData.name = roomEntity.name;
      //TODO: rules
      this.logger.log(`Game room ${roomId} updated`);
    }
  }

  getRoomByPeer(socketId: string): GameRoomRuntime | undefined {
    return Array.from(this.gameRoomsRuntimes.values()).find((room) =>
      room.roomData.players.some((player) => player.socketId === socketId),
    );
  }

  async setupServer(socket: Server) {
    this.socket = socket;
    await this.upAllRooms();
  }

  async upAllRooms() {
    const rooms = await this.roomsRepository.find();
    for (const room of rooms) {
      this.createGameRoom(room.id, room);
    }
  }

  @OnEvent(RoomEvents.ROOM_CREATED)
  async onRoomCreated(event: RoomCreatedEvent) {
    this.createGameRoom(event.room.id, event.room);
  }

  @OnEvent(RoomEvents.ROOM_UPDATED)
  async onRoomUpdated(event: RoomUpdatedEvent) {
    this.updateRoom(event.room.id, event.room);
  }

  @OnEvent(RoomEvents.ROOM_DELETED)
  async onRoomDeleted(event: RoomDeletedEvent) {
    this.removeRoom(event.room.id);
  }

  async upsertPackage(pkg: ScriptingPackage) {
    if (pkg.room) {
      const room = this.getRoom(pkg.room.id);
      if (room) {
        room.wiredInstance.wiredGlobal
          ?.scene()
          .scriptsManagerNode?.packageManager.upsertPackage(
            instanceToPlain(pkg) as ScriptingPackageType,
          );
        this.logger.log(`Package ${pkg.id} upped`);
        return true;
      } else {
        this.logger.error(`Room ${pkg.room.id} not found`);
      }
    }
    this.logger.error(`Package ${pkg.id} not upped`);
    return false;
  }
  async removePackage(pkg: ScriptingPackage) {
    if (pkg.room) {
      const room = this.getRoom(pkg.room.id);
      if (room) {
        room.wiredInstance.wiredGlobal
          ?.scene()
          .scriptsManagerNode?.packageManager.removePackage(pkg.id);
        this.logger.log(`Package ${pkg.id} removed`);
        return true;
      } else {
        this.logger.error(`Room ${pkg.room.id} not found`);
      }
    }
    this.logger.error(`Package ${pkg.id} not removed`);
    return false;
  }

  async upAllPackages(roomEnt: Room) {
    const room = await this.getRoom(roomEnt.id);
    if (room) {
      const pkgs = await this.scriptingPackagesRepository.find({
        where: {
          room: {
            id: roomEnt.id,
          },
        },
        relations: [
          'author',
          'contributors',
          'room',
          'parentPackage',
          'childrenPackages',
        ],
      });
      for (const pkg of pkgs) {
        const result = await this.upsertPackage(pkg);
      }
    }
  }

  @OnEvent(ScriptingPackageEvents.SCRIPTING_PACKAGE_CREATED)
  async onPackageCreated(event: ScriptingPackageCreatedEvent) {
    const pkg = event.scriptingPackage;
    this.upsertPackage(pkg);
  }

  @OnEvent(ScriptingPackageEvents.SCRIPTING_PACKAGE_UPDATED)
  async onPackageUpdated(event: ScriptingPackageUpdatedEvent) {
    const pkg = event.scriptingPackage;
    this.upsertPackage(pkg);
  }

  @OnEvent(ScriptingPackageEvents.SCRIPTING_PACKAGE_DELETED)
  async onPackageDeleted(event: ScriptingPackageDeletedEvent) {
    const pkg = event.scriptingPackage;
    this.removePackage(pkg);
  }

  async createGameRoom(
    roomId: number,
    roomEntity: Room,
  ): Promise<GameRoomRuntime> {
    if (!this.socket) {
      throw new Error('Socket not found');
    }
    const room: GameRoomData = {
      id: roomId,
      name: roomEntity.name,
      players: [],
    };
    const api = new NetworkAPI();
    api.setSocket(this.socket);

    const roomRuntime = new GameRoomRuntime(
      room,
      api,
      new WiredInstance({ network: api, displayParent: '' }),
    );

    roomRuntime.wiredInstance.events.addListener('sceneReady', () => {
      this.upAllPackages(roomEntity);
    });

    api.setRoom(roomRuntime);
    this.gameRoomsRuntimes.set(roomId.toString(), roomRuntime);
    roomRuntime.setup();
    this.logger.log(`Game room ${roomId} created`);
    return roomRuntime;
  }
}
