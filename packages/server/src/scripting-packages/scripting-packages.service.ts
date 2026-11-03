import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { PackageFileEntry } from '@wired-io/shared';
import { errorMessage } from 'src/common/errors';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import { canEditRoom, canViewRoom, isRoomMember } from 'src/rooms/room-access';
import {
  PackageStorageService,
  RevisionKind,
} from './package-storage.service';
import { PinnedPackage, walkPinnedClosure } from './package-dependency-graph';
import { PackageDeliveryService } from './package-delivery.service';
import { PackagePublishLockService } from './package-publish-lock.service';
import { rewriteSlugReferences } from './package-slug-rewrite';
import { normalizeTags } from './package-tags';
import {
  PACKAGE_REVISION_DISPATCHER,
  PackageRevisionDispatcher,
} from 'src/common/runtime-contracts';
import {
  PackageSlugAvailability,
  isValidPackageSlug,
} from '@wired-io/shared';

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
    private readonly storage: PackageStorageService,
    @Inject(PACKAGE_REVISION_DISPATCHER)
    private readonly dispatcher: PackageRevisionDispatcher,
    private readonly delivery: PackageDeliveryService,
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisionsRepository: Repository<ScriptingPackageRevision>,
    private readonly locks: PackagePublishLockService,
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
    if (!isValidPackageSlug(normalized)) {
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
   * `excludeId` drops one package from both scopes, so a rename does not
   * report its own current slug as taken.
   */
  async checkSlugAvailability(
    slug: string,
    roomId?: number,
    excludeId?: number,
  ): Promise<PackageSlugAvailability> {
    const normalized = this.normalizeSlug(slug);
    const notSelf = excludeId === undefined ? {} : { id: Not(excludeId) };

    const globalLive = await this.packagesRepository.findOne({
      where: { slug: normalized, room: IsNull(), ...notSelf },
    });
    const scope: PackageSlugAvailability['global'] = globalLive
      ? { available: false, reason: 'taken' }
      : { available: true };

    if (roomId === undefined) {
      return { slug: normalized, ...scope, global: scope };
    }

    const live = await this.packagesRepository.findOne({
      where: { slug: normalized, room: { id: roomId }, ...notSelf },
    });
    return live
      ? { slug: normalized, available: false, reason: 'taken', global: scope }
      : { slug: normalized, available: true, global: scope };
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
    const isRoomMemberOfRoom = Boolean(pkg.room) && isRoomMember(pkg.room!, user.id);

    if (!isAuthor && !isContributor && !isRoomMemberOfRoom) {
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

  findOne(id: number): Promise<ScriptingPackage> {
    return this.packagesRepository
      .findOne({
        where: { id },
        relations: [
          'author',
          'contributors',
          'room',
          'parentPackage',
          'childrenPackages',
        ],
      })
      .then((pkg) => {
        if (!pkg) {
          throw new NotFoundException(`ScriptingPackage with id=${id} not found`);
        }
        return pkg;
      });
  }

  /**
   * A package as seen by `viewer`: workshop packages are catalogue entries,
   * room packages follow the room's own visibility.
   *
   * A package in a room the viewer cannot see answers like a missing one, so
   * probing ids cannot distinguish private packages from nonexistent ones.
   */
  async findVisibleOne(
    id: number,
    viewer: User | null,
  ): Promise<ScriptingPackage> {
    const pkg = await this.packagesRepository.findOne({
      where: { id },
      relations: [
        'author',
        'contributors',
        'room',
        'room.author',
        'room.contributors',
        'parentPackage',
        'childrenPackages',
      ],
    });
    if (!pkg || (pkg.room && !canViewRoom(pkg.room, viewer?.id))) {
      throw new NotFoundException(`ScriptingPackage with id=${id} not found`);
    }
    return pkg;
  }

  async create(
    dto: CreateScriptingPackageDto,
    user: User,
  ): Promise<ScriptingPackage> {
    const { roomId, parentPackageId, ...data } = dto;

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

    const foundRoom = await this.roomsRepository.findOne({
      where: { id: roomId },
      relations: ['author', 'contributors'],
    });
    if (!foundRoom) {
      throw new NotFoundException(`Room with id=${roomId} not found`);
    }
    const canEdit = isRoomMember(foundRoom, user.id);
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
    if (dto.slug !== undefined) {
      const next = this.normalizeSlug(dto.slug);
      if (next !== pkg.slug) {
        return this.renameSlug(pkg, next, dto);
      }
    }
    return this.applyUpdate(pkg, dto);
  }

  /** Plain PATCH: everything except the slug, which only a rename sets. */
  private async applyUpdate(
    pkg: ScriptingPackage,
    dto: UpdateScriptingPackageDto,
  ): Promise<ScriptingPackage> {
    const enabledChanged = await this.preparePackageUpdate(pkg, dto);
    const saved = await this.packagesRepository.save(pkg);
    if (enabledChanged) {
      await this.notifyEnabledChanged(saved.id);
    }
    return this.findOne(saved.id);
  }

  /**
   * Applies every editable field except `slug` and reports whether `enabled`
   * flipped, because that needs its own dispatch. Both PATCH paths share it so
   * a rename cannot apply metadata differently from a plain update.
   */
  private async preparePackageUpdate(
    pkg: ScriptingPackage,
    dto: UpdateScriptingPackageDto,
  ): Promise<boolean> {
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

    const previousEnabled = pkg.enabled !== false;
    if (dto.enabled === true && previousEnabled === false) {
      await this.assertEnableable(pkg.id);
    }
    if (dto.enabled !== undefined) pkg.enabled = dto.enabled;

    return dto.enabled !== undefined && dto.enabled !== previousEnabled;
  }

  private async notifyEnabledChanged(packageId: number): Promise<void> {
    try {
      await this.dispatcher.packageEnabledChanged(packageId);
    } catch (error) {
      this.logger.warn(
        `Package ${packageId} was saved but its room was not notified: ${
          errorMessage(error)
        }`,
      );
    }
  }

  /**
   * Renames a room package. The slug is the directory name, so the published
   * and draft bytes that reference `res://packages/<old>/` are rewritten in the
   * same transaction that swaps the slug; dependents in the same room are
   * rewritten too, after an explicit confirmation. Artifacts are built from
   * these bytes but keyed by `(packageId, revision)`, so they must be dropped.
   */
  private async renameSlug(
    pkg: ScriptingPackage,
    nextSlug: string,
    dto: UpdateScriptingPackageDto,
  ): Promise<ScriptingPackage> {
    if (!pkg.room) {
      throw new BadRequestException({
        code: 'slug_not_editable',
        message:
          'Slug пакета workshop нельзя изменить: создайте новую запись',
      });
    }
    const roomId = pkg.room.id;
    const scope = `room:${roomId}`;
    const prepared: Array<{
      packageId: number;
      revision: number;
      kind: RevisionKind;
    }> = [];
    let rewrittenIds: number[] = [];
    let enabledChanged = false;

    try {
      await this.packagesRepository.manager.transaction(async (manager) => {
        const packages = manager.getRepository(ScriptingPackage);
        // Another client may have renamed this package between the outer read
        // and this lock. The row lock keeps the slug stable for the rewrite,
        // and the rewrite source must be the slug the bytes actually use.
        const current = await packages.findOne({
          where: { id: pkg.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!current) {
          throw new NotFoundException(`Package ${pkg.id} not found`);
        }
        const oldSlug = current.slug ?? String(pkg.id);
        if (oldSlug === nextSlug) {
          // The target slug is already in place: only the other fields apply.
          enabledChanged = await this.preparePackageUpdate(current, dto);
          await packages.save(current);
          return;
        }
        const lockKeys = [
          `package_slug:${scope}:${oldSlug}`,
          `package_slug:${scope}:${nextSlug}`,
        ].sort();
        for (const key of lockKeys) {
          await manager.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [key],
          );
        }
        const live = await packages.findOne({
          where: { slug: nextSlug, room: { id: roomId } },
        });
        if (live && live.id !== pkg.id) {
          throw new ConflictException({
            code: 'slug_taken',
            slug: nextSlug,
            message: 'Slug уже занят',
          });
        }
        const dependents =
          (await this.delivery.findDependentRoomPackages(pkg.id)) ?? [];
        if (dependents.length > 0 && dto.confirmSlugRename !== true) {
          const rows = await manager.getRepository(ScriptingPackage).find({
            where: { id: In(dependents.map((row) => row.packageId)) },
          });
          throw new ConflictException({
            code: 'slug_in_use_by_dependents',
            reason: 'dependents',
            message: 'На пакет ссылаются другие пакеты',
            dependents: rows
              .map((row) => ({ packageId: row.id, name: row.name }))
              .sort((a, b) => a.packageId - b.packageId),
          });
        }

        await this.locks.runWithPublishLocks(
          [pkg.id, ...dependents.map((row) => row.packageId)],
          async () => {
            const revisions = manager.getRepository(ScriptingPackageRevision);
            const targets: Array<{
              packageId: number;
              revision: number;
              kind: RevisionKind;
            }> = [];
            for (const row of await revisions.find({
              where: { package: { id: pkg.id } },
            })) {
              if (row.status === 'published' || row.status === 'draft') {
                targets.push({
                  packageId: pkg.id,
                  revision: row.revision,
                  kind: row.status,
                });
              }
            }
            for (const dependent of dependents) {
              for (const row of await revisions.find({
                where: {
                  package: { id: dependent.packageId },
                  status: 'published',
                },
              })) {
                targets.push({
                  packageId: dependent.packageId,
                  revision: row.revision,
                  kind: 'published',
                });
              }
            }

            const transform = (filepath: string, data: Buffer) =>
              rewriteSlugReferences(filepath, data, oldSlug, nextSlug);
            const rewritten: Array<{
              id: number;
              files: PackageFileEntry[];
            }> = [];
            for (const target of targets) {
              prepared.push(target);
              const files = await this.storage.rewriteRevision(
                target.packageId,
                target.revision,
                target.kind,
                transform,
              );
              if (!files) continue;
              const row = await revisions.findOneOrFail({
                where: {
                  package: { id: target.packageId },
                  revision: target.revision,
                },
              });
              // A draft declares only the files uploaded so far: keep that
              // set and refresh the hashes of the files that are on disk.
              const nextFiles =
                target.kind === 'published'
                  ? files
                  : this.mergeRevisionFiles(row.files ?? [], files);
              rewritten.push({ id: row.id, files: nextFiles });
            }

            const changedEnabled = await this.preparePackageUpdate(pkg, dto);
            pkg.slug = nextSlug;
            await manager.getRepository(ScriptingPackage).save(pkg);
            for (const row of rewritten) {
              await manager
                .getRepository(ScriptingPackageRevision)
                .update({ id: row.id }, { files: row.files });
            }
            rewrittenIds = [
              ...new Set(targets.map((target) => target.packageId)),
            ].sort((a, b) => a - b);
            enabledChanged = changedEnabled;
          },
        );
      });
    } catch (error) {
      for (const target of prepared.reverse()) {
        await this.storage
          .abortRewrite(target.packageId, target.revision, target.kind)
          .catch((cause) =>
            this.logger.warn(`rewrite abort failed: ${String(cause)}`),
          );
      }
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Package ${pkg.id} slug rewrite failed: ${String(error)}`,
      );
      throw new InternalServerErrorException({
        code: 'slug_rewrite_failed',
        message: 'Не удалось переписать ссылки на пакет',
      });
    }

    for (const target of prepared) {
      await this.storage
        .finishRewrite(target.packageId, target.revision, target.kind)
        .catch((cause) =>
          this.logger.warn(`rewrite cleanup failed: ${String(cause)}`),
        );
    }
    for (const packageId of rewrittenIds) {
      await this.delivery
        .invalidatePackage(packageId)
        .catch((cause) =>
          this.logger.warn(`artifact invalidation failed: ${String(cause)}`),
        );
    }
    if (rewrittenIds.length > 0) {
      try {
        await this.dispatcher.packagesChanged(rewrittenIds);
      } catch (cause) {
        this.logger.warn(
          `Package ${pkg.id} was renamed but its room was not notified: ${String(
            cause,
          )}`,
        );
      }
    }
    if (enabledChanged) {
      await this.notifyEnabledChanged(pkg.id);
    }
    return this.findOne(pkg.id);
  }

  /** Refreshes the declared size and hash of the files that were rewritten. */
  private mergeRevisionFiles(
    declared: PackageFileEntry[],
    rewritten: PackageFileEntry[],
  ): PackageFileEntry[] {
    const byPath = new Map(
      rewritten.map((entry) => [entry.filepath, entry] as const),
    );
    return declared.map((entry) => byPath.get(entry.filepath) ?? entry);
  }

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
    const roomId = pkg.room.id;
    await walkPinnedClosure([packageId], {
      load: (currentId) => this.loadPinnedPackage(currentId),
      onDiscover: async (dependencyId) => {
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
        return true;
      },
    });
  }

  /** The latest published revision of a package and the dependencies it pins. */
  private async loadPinnedPackage(packageId: number): Promise<PinnedPackage> {
    const latest = await this.revisionsRepository.findOne({
      where: { package: { id: packageId }, status: 'published' },
      relations: { package: true },
      order: { revision: 'DESC' },
    });
    if (!latest) {
      return { revision: null, pins: null };
    }
    const pins = await this.storage.readPinnedDependencies(
      packageId,
      latest.revision,
    );
    return { revision: latest.revision, pins: pins ? [...pins.keys()] : null };
  }

  /**
   * A room package may reference files of another package by absolute path
   * (`res://packages/<id>/...`), and the runtime keeps those references
   * pointing into the referenced package's own directory. Deleting a package
   * whose files are still referenced would therefore break every enabled
   * dependent on its next reload, so the delete is refused while one exists.
   */
  private async assertNoEnabledDependents(packageId: number): Promise<void> {
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
      await this.storage.removePackage(id);
    } catch (error) {
      this.logger.warn(
        `ScriptingPackage ${id} was deleted but its files were not removed: ${
          errorMessage(error)
        }`,
      );
    }
    if (roomId !== null) {
      try {
        this.dispatcher.packageRemoved(id, roomId);
      } catch (error) {
        this.logger.warn(
          `Package ${id} was deleted but its room was not notified: ${
            errorMessage(error)
          }`,
        );
      }
    }
  }
}
