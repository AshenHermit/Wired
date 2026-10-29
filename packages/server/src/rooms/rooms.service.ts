import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { canEditRoom, canViewRoom } from './room-access';

@Injectable()
export class RoomsService {
  constructor(
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
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
    if (!canEditRoom(room, user.id)) {
      throw new ForbiddenException('You are not allowed to edit this room');
    }
  }

  findAll(user?: User | null): Promise<Room[]> {
    const where: FindOptionsWhere<Room> | FindOptionsWhere<Room>[] = user
      ? [
          { isPublic: true },
          { author: { id: user.id } },
          { contributors: { id: user.id } },
        ]
      : { isPublic: true };

    return this.roomsRepository.find({
      where,
      relations: ['author', 'contributors', 'scriptingPackages'],
      // A WHERE on a joined relation would otherwise drop the other
      // contributors of a private room from the hydrated array.
      relationLoadStrategy: 'query',
    });
  }

  async findVisibleOne(id: number, user?: User | null): Promise<Room> {
    const room = await this.findOne(id);

    if (!canViewRoom(room, user?.id)) {
      // 404 rather than 403 so private room ids cannot be probed.
      throw new NotFoundException(`Room with id=${id} not found`);
    }
    return room;
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

  async create(dto: CreateRoomDto, author: User): Promise<Room> {
    // Only whitelisted DTO fields are copied; the author always comes from the
    // authenticated request, never from the request body.
    const room = this.roomsRepository.create({
      name: dto.name,
      isPublic: dto.isPublic,
      description: dto.description,
      type: dto.type,
      parentRoomId: dto.parentRoomId ?? null,
      author,
    });

    const saved = await this.roomsRepository.save(room);
    return this.findOne(saved.id);
  }

  async update(id: number, dto: UpdateRoomDto): Promise<Room> {
    const room = await this.findOne(id);

    if (dto.parentRoomId && dto.parentRoomId === id) {
      throw new BadRequestException(
        'Комната не может быть родителем самой себе',
      );
    }

    if (dto.name !== undefined) room.name = dto.name;
    if (dto.isPublic !== undefined) room.isPublic = dto.isPublic;
    if (dto.description !== undefined) room.description = dto.description;
    if (dto.parentRoomId !== undefined) room.parentRoomId = dto.parentRoomId;

    const saved = await this.roomsRepository.save(room);
    return this.findOne(saved.id);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    const result = await this.roomsRepository.delete(id);
    if (!result.affected) {
      throw new NotFoundException(`Room with id=${id} not found`);
    }
  }
}
