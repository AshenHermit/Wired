import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import { canEditRoom } from 'src/rooms/room-access';
import { PackageStorageService } from './package-storage.service';
import { PackageDeliveryService } from './package-delivery.service';
import {
  PACKAGE_REVISION_DISPATCHER,
  PackageRevisionDispatcher,
} from 'src/godot-game/package-sync.types';

@Injectable()
export class ScriptingPackagesService {
  private readonly logger = new Logger(ScriptingPackagesService.name);

  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository: Repository<ScriptingPackage>,
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
    @Optional()
    private readonly storage?: PackageStorageService,
    @Optional()
    @Inject(PACKAGE_REVISION_DISPATCHER)
    private readonly dispatcher?: PackageRevisionDispatcher,
    @Optional()
    private readonly delivery?: PackageDeliveryService,
    @Optional()
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisionsRepository?: Repository<ScriptingPackageRevision>,
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

    const previousEnabled = pkg.enabled !== false;
    if (dto.enabled === true && previousEnabled === false) {
      await this.assertEnableable(id);
    }
    if (dto.enabled !== undefined) pkg.enabled = dto.enabled;

    const saved = await this.packagesRepository.save(pkg);
    if (dto.enabled !== undefined && dto.enabled !== previousEnabled) {
      try {
        await this.dispatcher?.packageEnabledChanged(id);
      } catch (error) {
        this.logger.warn(
          `Package ${id} was saved but its room was not notified: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return this.findOne(saved.id);
  }

  /**
   * A room package may reference files of another package by absolute path
   * (`res://packages/<id>/...`), and the runtime keeps those references
   * pointing into the referenced package's own directory. Deleting a package
   * whose files are still referenced would therefore break every enabled
   * dependent on its next reload, so the delete is refused while one exists.
   */
  /**
   * Enabling is the fourth invariant point: a package may have been disabled
   * while one of its dependencies was deleted, and dispatching it then would
   * fail every later game connection for the room.
   */
  private async assertEnableable(packageId: number): Promise<void> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId },
      relations: { room: true },
    });
    if (!pkg?.room) return;
    if (!this.revisionsRepository || !this.storage) return;
    const roomId = pkg.room.id;
    const visited = new Set<number>();
    const queue: number[] = [packageId];
    while (queue.length > 0) {
      const currentId = queue.pop() as number;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const latest = await this.revisionsRepository.findOne({
        where: { package: { id: currentId }, status: 'published' },
        relations: { package: true },
        order: { revision: 'DESC' },
      });
      if (!latest) continue;
      const pins = await this.storage.readPinnedDependencies(
        currentId,
        latest.revision,
      );
      if (!pins) continue;
      for (const dependencyId of pins.keys()) {
        if (visited.has(dependencyId)) continue;
        const dependency = await this.packagesRepository.findOne({
          where: { id: dependencyId },
          relations: { room: true },
        });
        if (!dependency) {
          throw new ConflictException({
            statusCode: 409,
            code: 'dependency_missing',
            message: `Dependency ${dependencyId} was deleted`,
            dependencyId,
          });
        }
        if (dependency.enabled === false && dependency.room?.id === roomId) {
          throw new ConflictException({
            statusCode: 409,
            code: 'dependency_disabled',
            message: `Dependency ${dependencyId} is disabled in this room`,
            dependencyId,
            name: dependency.name,
          });
        }
        queue.push(dependencyId);
      }
    }
  }

  private async assertNoEnabledDependents(packageId: number): Promise<void> {
    if (!this.delivery) {
      return;
    }
    const dependents = await this.delivery.findDependentRoomPackages(packageId);
    if (dependents.length === 0) {
      return;
    }
    const rows = await this.packagesRepository.find({
      where: { id: In(dependents.map((dependent) => dependent.packageId)) },
    });
    const blocking = rows
      .filter((row) => row.enabled !== false)
      .map((row) => ({ packageId: row.id, name: row.name }))
      .sort((a, b) => a.packageId - b.packageId);
    if (blocking.length === 0) {
      return;
    }
    throw new ConflictException({
      statusCode: 409,
      code: 'package_has_dependents',
      message: 'Enabled packages depend on this package',
      dependents: blocking,
    });
  }

  /**
   * Deletes the package row and then every stored file of the package. The
   * revision rows cascade with the package, but nothing on disk does: without
   * the cleanup `revisions/<n>` and `runtime/v1/<room>/...` stay orphaned.
   *
   * The row is authoritative, so a disk failure is logged instead of turning a
   * completed deletion into an error.
   */
  async remove(id: number): Promise<void> {
    await this.assertNoEnabledDependents(id);
    const pkg = await this.findOne(id);
    const roomId = pkg.room?.id ?? null;
    const result = await this.packagesRepository.delete(id);
    if (!result.affected) {
      throw new NotFoundException(`ScriptingPackage with id=${id} not found`);
    }
    try {
      await this.storage?.removePackage(id);
    } catch (error) {
      this.logger.warn(
        `ScriptingPackage ${id} was deleted but its files were not removed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (roomId !== null) {
      try {
        this.dispatcher?.packageRemoved(id, roomId);
      } catch (error) {
        this.logger.warn(
          `Package ${id} was deleted but its room was not notified: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
