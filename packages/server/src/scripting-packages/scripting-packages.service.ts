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

@Injectable()
export class ScriptingPackagesService {
  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository: Repository<ScriptingPackage>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
  ) {}

  async assertPackageCreation(
    user: User,
    dto: CreateScriptingPackageDto,
  ): Promise<void> {
    if (dto.authorId !== user.id) {
      throw new ForbiddenException(
        'You are not allowed to create this package',
      );
    }
  }
  async assertPackageEditing(user: User, packageId: number): Promise<void> {
    const pkg = await this.findOne(packageId);
    if (pkg.room) {
      // TODO: rules later
    } else {
      if (!pkg.author || pkg.author.id !== user.id) {
        throw new ForbiddenException(
          'You are not allowed to edit this package',
        );
      }
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

  async create(dto: CreateScriptingPackageDto): Promise<ScriptingPackage> {
    const { authorId, roomId, parentPackageId, ...data } = dto;

    const pkg = this.packagesRepository.create({
      ...data,
    });

    if (authorId) {
      const author = await this.usersRepository.findOne({
        where: { id: authorId },
      });
      if (!author) {
        throw new NotFoundException(`Author with id=${authorId} not found`);
      }
      pkg.author = author;
    }

    if (roomId) {
      const room = await this.roomsRepository.findOne({
        where: { id: roomId },
      });
      if (!room) {
        throw new NotFoundException(`Room with id=${roomId} not found`);
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

    return this.packagesRepository.save(pkg);
  }

  async update(
    id: number,
    dto: UpdateScriptingPackageDto,
  ): Promise<ScriptingPackage> {
    const pkg = await this.findOne(id);

    if (dto.authorId) {
      const author = await this.usersRepository.findOne({
        where: { id: dto.authorId },
      });
      if (!author) {
        throw new NotFoundException(`Author with id=${dto.authorId} not found`);
      }
      pkg.author = author;
    }

    if (dto.roomId) {
      const room = await this.roomsRepository.findOne({
        where: { id: dto.roomId },
      });
      if (!room) {
        throw new NotFoundException(`Room with id=${dto.roomId} not found`);
      }
      pkg.room = room;
    }

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

    return this.packagesRepository.save(pkg);
  }

  async remove(id: number): Promise<void> {
    const result = await this.packagesRepository.delete(id);
    if (!result.affected) {
      throw new NotFoundException(`ScriptingPackage with id=${id} not found`);
    }
  }
}
