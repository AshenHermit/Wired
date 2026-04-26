import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ScriptingPackageCreatedEvent,
  ScriptingPackageDeletedEvent,
  ScriptingPackageEvents,
  ScriptingPackageUpdatedEvent,
} from 'src/events/scripting-package.events';
import path from 'path';
import { AppConfigService } from 'src/config/config.service';
import * as fs from 'fs';
import sha256 from 'crypto-js/sha256';

@Injectable()
export class ScriptingPackagesService {
  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository: Repository<ScriptingPackage>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: AppConfigService,
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

    const saved = await this.packagesRepository.save(pkg);
    const found = await this.findOne(saved.id);
    this.eventEmitter.emit(
      ScriptingPackageEvents.SCRIPTING_PACKAGE_CREATED,
      new ScriptingPackageCreatedEvent(found),
    );
    return saved;
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
    if (dto.physicalFiles !== undefined) pkg.physicalFiles = dto.physicalFiles;

    const saved = await this.packagesRepository.save(pkg);
    const found = await this.findOne(id);
    this.eventEmitter.emit(
      ScriptingPackageEvents.SCRIPTING_PACKAGE_UPDATED,
      new ScriptingPackageUpdatedEvent(found),
    );
    return saved;
  }

  async remove(id: number): Promise<void> {
    const pkg = await this.findOne(id);
    const result = await this.packagesRepository.delete(id);
    if (!result.affected) {
      throw new NotFoundException(`ScriptingPackage with id=${id} not found`);
    }
    this.eventEmitter.emit(
      ScriptingPackageEvents.SCRIPTING_PACKAGE_DELETED,
      new ScriptingPackageDeletedEvent(pkg),
    );
  }

  getPhysicalFileFullPath(pkg: ScriptingPackage, filepath: string): string {
    return path.join(
      this.configService.storage.packagesFilesDir,
      pkg.id.toString(),
      filepath,
    );
  }

  async updatePhysicalFileHash(
    pkg: ScriptingPackage,
    filepath: string,
  ): Promise<void> {
    const fullPath = this.getPhysicalFileFullPath(pkg, filepath);
    const hash = sha256(fs.readFileSync(fullPath, 'utf8'));
    pkg.physicalFiles = pkg.physicalFiles.map((file) =>
      file.filepath === filepath ? { ...file, hash: hash.toString() } : file,
    );
    await this.packagesRepository.save(pkg);
  }

  async uploadPhysicalFile(
    id: number,
    file: Express.Multer.File,
    filepath: string,
  ): Promise<boolean> {
    const pkg = await this.findOne(id);
    const fullPath = this.getPhysicalFileFullPath(pkg, filepath);
    if (fs.existsSync(path.dirname(fullPath))) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    }
    fs.writeFileSync(fullPath, file.buffer);
    await this.updatePhysicalFileHash(pkg, filepath);
    return true;
  }

  async getPhysicalFile(id: number, filepath: string): Promise<StreamableFile> {
    const pkg = await this.findOne(id);
    const fullPath = this.getPhysicalFileFullPath(pkg, filepath);
    if (!fs.existsSync(fullPath)) {
      throw new NotFoundException(
        `Physical file with filepath=${filepath} not found`,
      );
    }
    return new StreamableFile(fs.createReadStream(fullPath));
  }
}
