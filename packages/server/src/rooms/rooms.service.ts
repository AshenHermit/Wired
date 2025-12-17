import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  RoomCreatedEvent,
  RoomDeletedEvent,
  RoomEvents,
  RoomUpdatedEvent,
} from 'src/events/room.events';

@Injectable()
export class RoomsService {
  constructor(
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async assertRoomCreation(user: User, room: CreateRoomDto): Promise<void> {
    if (room.authorId !== user.id) {
      throw new ForbiddenException('You are not allowed to create this room');
    }
    if (room.parentRoomId) {
      // TODO: rules later
      await this.assertRoomEditing(user, room.parentRoomId);
    }
  }

  async assertRoomEditing(user: User, roomId: number): Promise<void> {
    const room = await this.findOne(roomId);
    if (!room.author || room.author.id !== user.id) {
      throw new ForbiddenException('You are not allowed to edit this room');
    }
  }

  findAll(): Promise<Room[]> {
    return this.roomsRepository.find({
      relations: ['author', 'contributors', 'scriptingPackages'],
    });
  }

  async findOne(id: number): Promise<Room> {
    const room = await this.roomsRepository.findOne({
      where: { id },
      relations: ['author', 'contributors', 'scriptingPackages'],
    });
    if (!room) {
      throw new NotFoundException(`Room with id=${id} not found`);
    }
    return room;
  }

  async create(dto: CreateRoomDto): Promise<Room> {
    const { authorId, ...data } = dto;
    const room = this.roomsRepository.create({
      ...data,
    });

    if (authorId) {
      const author = await this.usersRepository.findOne({
        where: { id: authorId },
      });
      if (!author) {
        throw new NotFoundException(`Author with id=${authorId} not found`);
      }
      room.author = author;
    }

    const saved = await this.roomsRepository.save(room);
    const found = await this.findOne(saved.id);
    this.eventEmitter.emit(
      RoomEvents.ROOM_CREATED,
      new RoomCreatedEvent(found),
    );
    return saved;
  }

  async update(id: number, dto: UpdateRoomDto): Promise<Room> {
    const room = await this.findOne(id);

    if (dto.parentRoomId && dto.parentRoomId == id) {
      throw new ForbiddenException('ARE YOU INSANE?');
    }

    if (dto.authorId) {
      const author = await this.usersRepository.findOne({
        where: { id: dto.authorId },
      });
      if (!author) {
        throw new NotFoundException(`Author with id=${dto.authorId} not found`);
      }
      room.author = author;
    }

    if (dto.name !== undefined) room.name = dto.name;
    if (dto.isPublic !== undefined) room.isPublic = dto.isPublic;
    if (dto.description !== undefined) room.description = dto.description;
    if (dto.parentRoomId !== undefined) room.parentRoomId = dto.parentRoomId;

    const saved = await this.roomsRepository.save(room);
    const found = await this.findOne(saved.id);
    this.eventEmitter.emit(
      RoomEvents.ROOM_UPDATED,
      new RoomUpdatedEvent(found),
    );
    return saved;
  }

  async remove(id: number): Promise<void> {
    const room = await this.findOne(id);
    const result = await this.roomsRepository.delete(id);
    if (!result.affected) {
      throw new NotFoundException(`Room with id=${id} not found`);
    }
    this.eventEmitter.emit(RoomEvents.ROOM_DELETED, new RoomDeletedEvent(room));
  }
}
