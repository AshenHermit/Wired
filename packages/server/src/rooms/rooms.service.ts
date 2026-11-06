import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { withPublicUsers } from 'src/common/public-user';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { UpdateRoomAccessDto } from './dto/update-room-access.dto';
import { canEditRoom, canViewRoom } from './room-access';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class RoomsService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
    private readonly usersService: UsersService,
  ) {}

  async assertRoomCreation(user: User, room: CreateRoomDto): Promise<void> {
    if (room.parentRoomId) {
      // TODO: rules later
      await this.assertRoomEditing(user, room.parentRoomId);
    }
  }

  async assertRoomEditing(user: User, roomId: number): Promise<void> {
    return this.assertRoomAccessEditing(user, roomId);
  }

  async assertRoomAccessEditing(user: User, roomId: number): Promise<void> {
    const room = await this.findOne(roomId);
    if (!canEditRoom(room, user.id)) {
      throw new ForbiddenException('You are not allowed to edit this room');
    }
  }

  async findAll(user?: User | null): Promise<Room[]> {
    const where: FindOptionsWhere<Room> | FindOptionsWhere<Room>[] = user
      ? [
          { isPublic: true },
          { author: { id: user.id } },
          { contributors: { id: user.id } },
        ]
      : { isPublic: true };

    const rooms = await this.roomsRepository.find({
      where,
      relations: ['author', 'contributors', 'scriptingPackages'],
      // A WHERE on a joined relation would otherwise drop the other
      // contributors of a private room from the hydrated array.
      relationLoadStrategy: 'query',
    });
    // Anonymous callers read this list, so the embedded users lose their email.
    return rooms.map(withPublicUsers);
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
    // Anonymous callers read this room, so the embedded users lose their email.
    return withPublicUsers(room);
  }

  async onApplicationBootstrap(): Promise<void> {
    // Backfill rooms created before access policies existed. Only rows whose
    // policy fields are still null are touched, so an explicitly configured
    // policy is never overwritten.
    const rooms = await this.roomsRepository.find({
      where: [
        { packageManagementAccess: IsNull() },
        { packageCreationAccess: IsNull() },
      ],
      relations: ['author', 'contributors'],
    });

    for (const room of rooms) {
      const userIds = Array.from(
        new Set(
          [
            room.author?.id,
            ...(room.contributors ?? []).map((c) => c?.id),
          ].filter((id): id is number => typeof id === 'number'),
        ),
      );

      let changed = false;
      if (room.packageManagementAccess == null) {
        room.packageManagementAccess = 'users';
        room.packageManagementUserIds = userIds;
        changed = true;
      } else if (room.packageManagementUserIds == null) {
        room.packageManagementUserIds = [];
        changed = true;
      }
      if (room.packageCreationAccess == null) {
        room.packageCreationAccess = 'users';
        room.packageCreationUserIds = userIds;
        changed = true;
      } else if (room.packageCreationUserIds == null) {
        room.packageCreationUserIds = [];
        changed = true;
      }

      if (changed) {
        await this.roomsRepository.save(room);
      }
    }
  }

  async create(dto: CreateRoomDto, author: User): Promise<Room> {
    // Only whitelisted DTO fields are copied; the author always comes from the
    // authenticated request, never from the request body.
    // New rooms start locked down to their author; access lists are empty.
    const room = this.roomsRepository.create({
      name: dto.name,
      isPublic: dto.isPublic,
      description: dto.description,
      type: dto.type,
      parentRoomId: dto.parentRoomId ?? null,
      author,
      packageManagementAccess: 'author',
      packageManagementUserIds: [],
      packageCreationAccess: 'author',
      packageCreationUserIds: [],
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

  async updateAccess(
    id: number,
    dto: UpdateRoomAccessDto,
    user: User,
  ): Promise<Room> {
    const room = await this.findOne(id);

    // Validate that all provided user IDs exist
    const userIdsToValidate = new Set<number>();

    if (
      dto.packageManagementUserIds &&
      dto.packageManagementUserIds.length > 0
    ) {
      dto.packageManagementUserIds.forEach((uid) => userIdsToValidate.add(uid));
    }

    if (dto.packageCreationUserIds && dto.packageCreationUserIds.length > 0) {
      dto.packageCreationUserIds.forEach((uid) => userIdsToValidate.add(uid));
    }

    if (userIdsToValidate.size > 0) {
      const invalidIds: number[] = [];

      for (const userId of userIdsToValidate) {
        const userExists = await this.usersService.findById(userId);
        if (!userExists) {
          invalidIds.push(userId);
        }
      }

      if (invalidIds.length > 0) {
        throw new BadRequestException(
          `The following user IDs do not exist: ${invalidIds.join(', ')}`,
        );
      }
    }

    // Update only the fields provided in the DTO
    if (dto.packageManagementAccess !== undefined) {
      room.packageManagementAccess = dto.packageManagementAccess;
    }
    if (dto.packageManagementUserIds !== undefined) {
      room.packageManagementUserIds = dto.packageManagementUserIds;
    }
    if (dto.packageCreationAccess !== undefined) {
      room.packageCreationAccess = dto.packageCreationAccess;
    }
    if (dto.packageCreationUserIds !== undefined) {
      room.packageCreationUserIds = dto.packageCreationUserIds;
    }

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
