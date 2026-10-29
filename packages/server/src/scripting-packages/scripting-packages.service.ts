import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import { canEditRoom } from 'src/rooms/room-access';

@Injectable()
export class ScriptingPackagesService {
  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository: Repository<ScriptingPackage>,
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
  ) {}

  assertPackageCreation(user: User, dto: CreateScriptingPackageDto): void {
    if (dto.authorId !== user.id) {
      throw new ForbiddenException(
        'You are not allowed to create this package',
      );
    }
  }
  async assertPackageEditing(user: User, packageId: number): Promise<void> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId },
      relations: ['author', 'contributors', 'room', 'room.author'],
    });
    if (!pkg) {
      throw new NotFoundException(
        `ScriptingPackage with id=${packageId} not found`,
      );
    }

    const isAuthor = pkg.author?.id === user.id;
    const isContributor = pkg.contributors?.some(
      (contributor) => contributor.id === user.id,
    );
    const isRoomAuthor = pkg.room ? canEditRoom(pkg.room, user.id) : false;

    if (!isAuthor && !isContributor && !isRoomAuthor) {
      throw new ForbiddenException('You are not allowed to edit this package');
    }
  }

  findAll(): Promise<ScriptingPackage[]> {
    return this.packagesRepository.find({
      relations: [
        'author',
        'contributors',
        'room',
        'parentPackage',
        'childrenPackages',
      ],
    });
  }

  async findOne(id: number): Promise<ScriptingPackage> {
    const pkg = await this.packagesRepository.findOne({
      where: { id },
      relations: [
        'author',
        'contributors',
        'room',
        'parentPackage',
        'childrenPackages',
      ],
    });
    if (!pkg) {
      throw new NotFoundException(`ScriptingPackage with id=${id} not found`);
    }
    return pkg;
  }

  async create(
    dto: CreateScriptingPackageDto,
    user: User,
  ): Promise<ScriptingPackage> {
    const { authorId, roomId, parentPackageId, ...data } = dto;

    const pkg = this.packagesRepository.create({
      ...data,
      author: user,
    });

    if (authorId !== undefined && authorId !== user.id) {
      throw new ForbiddenException(
        'You are not allowed to create a package for another author',
      );
    }

    if (roomId) {
      const room = await this.roomsRepository.findOne({
        where: { id: roomId },
        relations: ['author', 'contributors'],
      });
      if (!room) {
        throw new NotFoundException(`Room with id=${roomId} not found`);
      }
      const canEditRoom =
        room.author?.id === user.id ||
        room.contributors?.some((contributor) => contributor.id === user.id);
      if (!canEditRoom) {
        throw new ForbiddenException(
          'You are not allowed to attach a package to this room',
        );
      }
      pkg.room = room;
    }

    if (parentPackageId) {
      const parent = await this.packagesRepository.findOne({
        where: { id: parentPackageId },
      });
      if (!parent) {
        throw new NotFoundException(
          `Parent package with id=${parentPackageId} not found`,
        );
      }
      pkg.parentPackage = parent;
    }

    const saved = await this.packagesRepository.save(pkg);
    return this.findOne(saved.id);
  }

  async update(
    id: number,
    dto: UpdateScriptingPackageDto,
  ): Promise<ScriptingPackage> {
    const pkg = await this.findOne(id);

    // Authorship and room ownership are immutable through PATCH: otherwise a
    // room author allowed to edit a package could take it over or move it.
    if (dto.parentPackageId) {
      const parent = await this.packagesRepository.findOne({
        where: { id: dto.parentPackageId },
      });
      if (!parent) {
        throw new NotFoundException(
          `Parent package with id=${dto.parentPackageId} not found`,
        );
      }
      pkg.parentPackage = parent;
    }

    if (dto.name !== undefined) pkg.name = dto.name;
    if (dto.version !== undefined) pkg.version = dto.version;
    if (dto.description !== undefined) pkg.description = dto.description;
    if (dto.dependencies !== undefined) pkg.dependencies = dto.dependencies;
    if (dto.scripts !== undefined) pkg.scripts = dto.scripts;
    if (dto.physicalFiles !== undefined) pkg.physicalFiles = dto.physicalFiles;

    const saved = await this.packagesRepository.save(pkg);
    return this.findOne(saved.id);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    const result = await this.packagesRepository.delete(id);
    if (!result.affected) {
      throw new NotFoundException(`ScriptingPackage with id=${id} not found`);
    }
  }
}
