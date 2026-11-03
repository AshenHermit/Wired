import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import { canEditRoom } from 'src/rooms/room-access';
import { PackageStorageService } from './package-storage.service';
import { PackageDeliveryService } from './package-delivery.service';
import { normalizeTags } from './package-tags';
import {
  PACKAGE_REVISION_DISPATCHER,
  PackageRevisionDispatcher,
} from 'src/godot-game/package-sync.types';

/** Same rule as `CreateScriptingPackageDto`: lowercase, digits, `_`, 1-64. */
const SLUG_PATTERN = /^(?=.*[a-z])[a-z0-9_]+$/;
const SLUG_MAX_LENGTH = 64;

/** Availability of a slug in the requested scope plus the global scope. */
export type PackageSlugAvailability = {
  slug: string;
  available: boolean;
  reason?: 'taken';
  global: { available: boolean; reason?: 'taken' };
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

@Injectable()
export class ScriptingPackagesService implements OnApplicationBootstrap {
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

  /**
   * Packages created before slugs existed get their numeric id as a slug.
   * Idempotent: rows that already have a slug are left alone, so this also
   * covers a rolling deploy where an old build writes NULL slugs.
   */
  async onApplicationBootstrap(): Promise<void> {
    const updated = await this.packagesRepository.query(
      `UPDATE scripting_package
       SET slug = id::text
       WHERE slug IS NULL
       RETURNING id`,
    );
    this.logger.log(
      `Package slug backfill: ${
        Array.isArray(updated) ? updated.length : 0
      } row(s) updated`,
    );

    // Anything still slugless after the UPDATE means the backfill cannot be
    // trusted; refusing to start beats serving packages without a slug.
    const missing: Array<{ id: number }> = await this.packagesRepository.query(
      `SELECT id FROM scripting_package WHERE slug IS NULL OR slug = ''`,
    );
    if (Array.isArray(missing) && missing.length > 0) {
      const ids = missing.map((row) => row.id);
      this.logger.error(
        `Package slug backfill left ${ids.length} package(s) without a slug: ${ids.join(
          ', ',
        )}`,
      );
      throw new Error('package_slug_backfill_incomplete');
    }
  }

  normalizeSlug(slug: string): string {
    const normalized = typeof slug === 'string' ? slug.trim() : '';
    if (
      normalized.length === 0 ||
      normalized.length > SLUG_MAX_LENGTH ||
      !SLUG_PATTERN.test(normalized)
    ) {
      throw new BadRequestException({
        code: 'invalid_slug',
        message:
          'slug must contain lowercase latin letters, digits or _, and at least one letter',
      });
    }
    return normalized;
  }

  /**
   * Reports whether a slug is free in the requested scope. Without `roomId`
   * the requested scope is the global workshop, so `available` mirrors
   * `global`. The global scope is always reported: a room package may reuse a
   * workshop slug, but the create dialog still needs to know about a clash.
   */
  async checkSlugAvailability(
    slug: string,
    roomId?: number,
  ): Promise<PackageSlugAvailability> {
    const normalized = this.normalizeSlug(slug);

    const globalLive = await this.packagesRepository.findOne({
      where: { slug: normalized, room: IsNull() },
    });
    const scope: PackageSlugAvailability['global'] = globalLive
      ? { available: false, reason: 'taken' }
      : { available: true };

    if (roomId === undefined) {
      return { slug: normalized, ...scope, global: scope };
    }

    const live = await this.packagesRepository.findOne({
      where: { slug: normalized, room: { id: roomId } },
    });
    return live
      ? { slug: normalized, available: false, reason: 'taken', global: scope }
      : { slug: normalized, available: true, global: scope };
  }

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

  /**
   * Publishing is broader than editing: a room contributor may emit revisions.
   * Workshop packages (`room = null`) never receive revisions over HTTP, so
   * they are rejected even for their own author.
   */
  async assertPackagePublishing(user: User, packageId: number): Promise<void> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId },
      relations: [
        'author',
        'contributors',
        'room',
        'room.author',
        'room.contributors',
      ],
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
    const isRoomMember =
      Boolean(pkg.room) &&
      (pkg.room!.author?.id === user.id ||
        (pkg.room!.contributors?.some(
          (contributor) => contributor.id === user.id,
        ) ??
          false));

    if (!isAuthor && !isContributor && !isRoomMember) {
      throw new ForbiddenException(
        'You are not allowed to publish this package',
      );
    }
    if (!pkg.room) {
      throw new ConflictException({
        code: 'package_not_in_room',
        message: 'Workshop packages cannot receive revisions directly',
      });
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

    // Public creation always belongs to a room; the global workshop scope is
    // written only through `createGlobalRecord`.
    if (!roomId) {
      throw new BadRequestException({
        code: 'package_room_required',
        message: 'Пакет можно создать только в комнате',
      });
    }

    const slug = this.normalizeSlug(dto.slug);
    data.tags = normalizeTags(dto.tags ?? []);

    if (authorId !== undefined && authorId !== user.id) {
      throw new ForbiddenException(
        'You are not allowed to create a package for another author',
      );
    }

    const foundRoom = await this.roomsRepository.findOne({
      where: { id: roomId },
      relations: ['author', 'contributors'],
    });
    if (!foundRoom) {
      throw new NotFoundException(`Room with id=${roomId} not found`);
    }
    const canEdit =
      foundRoom.author?.id === user.id ||
      foundRoom.contributors?.some((contributor) => contributor.id === user.id);
    if (!canEdit) {
      throw new ForbiddenException(
        'You are not allowed to attach a package to this room',
      );
    }

    let parentPackage: ScriptingPackage | undefined;
    if (parentPackageId) {
      const parent = await this.packagesRepository.findOne({
        where: { id: parentPackageId },
      });
      if (!parent) {
        throw new NotFoundException(
          `Parent package with id=${parentPackageId} not found`,
        );
      }
      parentPackage = parent;
    }

    return this.insertPackage({
      slug,
      data,
      author: user,
      room: foundRoom,
      parentPackage,
      scope: { roomId },
    });
  }

  /**
   * The workshop's own write path: no room, no authorship from a DTO, and the
   * same slug checks as a room create but in the global scope.
   */
  async createGlobalRecord(input: {
    slug: string;
    name: string;
    version: string;
    description: string;
    tags: string[];
    author: User;
  }): Promise<ScriptingPackage> {
    return this.insertPackage({
      slug: this.normalizeSlug(input.slug),
      data: {
        name: input.name,
        version: input.version,
        description: input.description,
        tags: normalizeTags(input.tags),
      },
      author: input.author,
      scope: 'global',
    });
  }

  /**
   * Inserts one package row under a slug scoped either to a room or to the
   * global workshop. Slugs are unique per scope only, so the advisory lock and
   * the live check use the same scope.
   */
  private async insertPackage(params: {
    slug: string;
    data: Partial<ScriptingPackage>;
    author: User;
    room?: Room;
    parentPackage?: ScriptingPackage;
    scope: { roomId: number } | 'global';
  }): Promise<ScriptingPackage> {
    const { slug, data, author, room, parentPackage, scope } = params;
    const scopeKey = scope === 'global' ? 'global' : `room:${scope.roomId}`;

    const savedId = await this.packagesRepository.manager.transaction(
      async (manager) => {
        // Creates for the same slug are serialized across processes, so the
        // unique violation below only fires for a race with another writer.
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `package_slug:${scopeKey}:${slug}`,
        ]);

        const packages = manager.getRepository(ScriptingPackage);
        const live = await packages.findOne({
          where:
            scope === 'global'
              ? { slug, room: IsNull() }
              : { slug, room: { id: scope.roomId } },
        });
        if (live) {
          throw new ConflictException({
            code: 'slug_taken',
            slug,
            message: 'Slug уже занят',
          });
        }

        const pkg = packages.create({
          ...data,
          slug,
          author,
          room,
          parentPackage,
        });

        try {
          const saved = await packages.save(pkg);
          return saved.id;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictException({
              code: 'slug_taken',
              slug,
              message: 'Slug уже занят',
            });
          }
          throw error;
        }
      },
    );

    return this.findOne(savedId);
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
    if (dto.tags !== undefined) pkg.tags = normalizeTags(dto.tags);
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
   * the cleanup `revisions/<n>` and `runtime/v2/<room>/...` stay orphaned.
   * Legacy `runtime/v1` trees are ignored and left orphaned, never migrated.
   *
   * The row is authoritative, so a disk failure is logged instead of turning a
   * completed deletion into an error.
   */
  async remove(id: number): Promise<void> {
    await this.assertNoEnabledDependents(id);
    const pkg = await this.findOne(id);
    const roomId = pkg.room?.id ?? null;
    // A room slug is local and stays reusable; a workshop slug becomes free
    // again as well. The fallback only covers a row created before the startup
    // backfill ran.
    const slug = pkg.slug ?? String(id);
    const scope = pkg.room ? `room:${pkg.room.id}` : 'global';
    await this.packagesRepository.manager.transaction(async (manager) => {
      // Serialize with `create()` so a slug cannot be re-created while the
      // deletion is in flight.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `package_slug:${scope}:${slug}`,
      ]);
      // Children become standalone packages instead of blocking the delete on
      // their foreign key.
      await manager.query(
        'UPDATE scripting_package SET "parentPackageId" = NULL WHERE "parentPackageId" = $1',
        [id],
      );
      const result = await manager.delete(ScriptingPackage, id);
      if (!result.affected) {
        // Another request won the race: the row is already gone.
        throw new NotFoundException(`ScriptingPackage with id=${id} not found`);
      }
    });
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
