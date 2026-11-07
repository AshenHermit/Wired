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
import { EntityManager, In, IsNull, Not, Repository } from 'typeorm';
import { PackageFileEntry } from '@wired-io/shared';
import { errorMessage } from 'src/common/errors';
import { isUniqueViolation } from 'src/common/pg-errors';
import { withPublicUsers } from 'src/common/public-user';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { User } from 'src/database/entities/user.entity';
import { Room } from 'src/database/entities/room.entity';
import { CreateScriptingPackageDto } from './dto/create-scripting-package.dto';
import { UpdateScriptingPackageDto } from './dto/update-scripting-package.dto';
import { UpdatePackageAccessDto } from './dto/update-package-access.dto';
import {
  canCreateRoomPackages,
  canEditRoom,
  canManageRoomPackages,
  canViewRoom,
} from 'src/rooms/room-access';
import { UsersService } from 'src/users/users.service';
import {
  PackageStorageService,
  RevisionRewrite,
  RevisionTarget,
} from './storage/package-storage.service';
import {
  PinnedPackage,
  pinnedPackageLoader,
  walkPinnedClosure,
} from './publish/package-dependency-graph';
import { PackageDeliveryService } from './delivery/package-delivery.service';
import { PackagePublishLockService } from './publish/package-publish-lock.service';
import { packageSlugTaken } from './package-errors';
import { rewriteSlugReferences } from './storage/package-slug-rewrite';
import { normalizeTags } from './storage/package-tags';
import {
  PACKAGE_REVISION_DISPATCHER,
  PackageRevisionDispatcher,
} from 'src/common/runtime-contracts';
import { PackageSlugAvailability, isValidPackageSlug } from '@wired-io/shared';

/** What a slug rename had to touch, reported once the transaction commits. */
interface SlugRenameOutcome {
  /** Present only when a revision directory actually moved. */
  rewrite: RevisionRewrite | null;
  rewrittenIds: number[];
  enabledChanged: boolean;
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
    private readonly usersService: UsersService,
  ) {}

  /**
   * Packages created before slugs existed get their numeric id as a slug.
   * Idempotent: rows that already have a slug are left alone, so this also
   * covers a rolling deploy where an old build writes NULL slugs.
   *
   * Backfill null editingAccess to users mode with author + contributors +
   * room author. This preserves the existing behavior where all three groups
   * could edit.
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

    // Backfill null editingAccess to users mode with author + contributors +
    // room author. Use ORM to avoid raw SQL dependency on join table that
    // may not exist yet during bootstrap.
    const packagesToBackfill = await this.packagesRepository.find({
      where: { editingAccess: IsNull() },
      relations: ['author', 'contributors', 'room', 'room.author'],
    });

    for (const pkg of packagesToBackfill) {
      const userIds = Array.from(
        new Set(
          [
            pkg.author?.id,
            ...(pkg.contributors ?? []).map((c) => c?.id),
            pkg.room?.author?.id,
          ].filter((id): id is number => typeof id === 'number'),
        ),
      );

      pkg.editingAccess = 'users';
      pkg.editingUserIds = userIds;
    }

    if (packagesToBackfill.length > 0) {
      await this.packagesRepository.save(packagesToBackfill);
    }

    this.logger.log(
      `Package editing access backfill: ${packagesToBackfill.length} row(s) updated`,
    );
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

  /**
   * Loads the package with everything the access checks need.
   *
   * Editing and publishing ask different questions of the same row, so the
   * query, its relations and the not-found answer live here instead of being
   * restated in each and drifting apart.
   */
  private async loadForAccess(packageId: number): Promise<ScriptingPackage> {
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
    return pkg;
  }

  /** Whether the user wrote the package or was added to it directly. */
  private static ownsPackage(pkg: ScriptingPackage, user: User): boolean {
    return (
      pkg.author?.id === user.id ||
      Boolean(
        pkg.contributors?.some((contributor) => contributor.id === user.id),
      )
    );
  }

  /**
   * Whether a user can edit a package based on its editingAccess policy.
   *
   * The package author and the room author of `pkg.room` are always allowed:
   * a package policy can only expand access beyond these baseline owners, never
   * remove them. Contributors are only admitted through `editingUserIds`, not
   * through the contributor relation itself.
   *
   * - 'all': any authenticated user.
   * - 'users': a user listed in `editingUserIds`.
   * - 'author': only the package author (plus the always-allowed room author).
   */
  canEditPackage(pkg: ScriptingPackage, userId?: number | null): boolean {
    // Package author is always allowed
    if (userId != null && pkg.author?.id === userId) {
      return true;
    }

    // Room author is always allowed, regardless of the policy.
    if (userId != null && pkg.room?.author?.id === userId) {
      return true;
    }

    const access = pkg.editingAccess;

    // 'all' allows any authenticated user
    if (access === 'all') {
      return userId != null;
    }

    // 'users' requires an exact match in the access list
    if (access === 'users') {
      return userId != null && (pkg.editingUserIds ?? []).includes(userId);
    }

    // 'author' mode only allows the package author (already checked above)
    return false;
  }

  /**
   * Enforces package access administration: only the room author or the
   * package author may change the access policy. This is deliberately distinct
   * from `canEditPackage`, which is the edit-action policy — otherwise an `all`
   * edit policy would let anyone rewrite who may edit, and an `author` edit
   * policy would lock the room author out of administering access.
   *
   * Throws NotFoundException if the package does not exist, or
   * ForbiddenException if the user may not administer access.
   */
  async assertPackageAccessEditing(
    user: User,
    packageId: number,
  ): Promise<void> {
    const pkg = await this.loadForAccess(packageId);
    const isRoomAuthor = pkg.room ? canEditRoom(pkg.room, user.id) : false;
    if (!isRoomAuthor && pkg.author?.id !== user.id) {
      throw new ForbiddenException(
        'You are not allowed to change this package access',
      );
    }
  }

  async assertPackageEditing(user: User, packageId: number): Promise<void> {
    const pkg = await this.loadForAccess(packageId);
    if (!this.canEditPackage(pkg, user.id)) {
      throw new ForbiddenException('You are not allowed to edit this package');
    }
  }

  /**
   * Publishing is a room-level action: the package owner may always emit their
   * own package, and otherwise the room's `packageManagement` policy decides.
   * The legacy "any room member" bypass is gone — a contributor outside the
   * management policy can no longer emit or publish. Workshop packages
   * (`room = null`) never receive revisions over HTTP, so they are rejected
   * even for their own author.
   */
  async assertPackagePublishing(user: User, packageId: number): Promise<void> {
    const pkg = await this.loadForAccess(packageId);

    const canManageRoom =
      Boolean(pkg.room) && canManageRoomPackages(pkg.room!, user.id);

    if (
      !ScriptingPackagesService.ownsPackage(pkg, user) &&
      !canManageRoom
    ) {
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
          throw new NotFoundException(
            `ScriptingPackage with id=${id} not found`,
          );
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
    // Anonymous callers read this package, so its users lose their email.
    return withPublicUsers({
      ...pkg,
      ...(pkg.room ? { room: withPublicUsers(pkg.room) } : {}),
    });
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
    const canCreate = canCreateRoomPackages(foundRoom, user.id);
    if (!canCreate) {
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
    previewImage?: string | null;
    author: User;
  }): Promise<ScriptingPackage> {
    return this.insertPackage({
      slug: this.normalizeSlug(input.slug),
      data: {
        name: input.name,
        version: input.version,
        description: input.description,
        tags: normalizeTags(input.tags),
        previewImage: input.previewImage ?? null,
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
          throw packageSlugTaken(slug);
        }

        const pkg = packages.create({
          ...data,
          slug,
          author,
          room,
          parentPackage,
          editingAccess: 'author',
          editingUserIds: [],
        });

        try {
          const saved = await packages.save(pkg);
          return saved.id;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw packageSlugTaken(slug);
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

  async updateAccess(
    id: number,
    dto: UpdatePackageAccessDto,
    user: User,
  ): Promise<ScriptingPackage> {
    const pkg = await this.findOne(id);

    // Validate that all provided user IDs exist
    const userIdsToValidate = new Set<number>();

    if (dto.editingUserIds && dto.editingUserIds.length > 0) {
      dto.editingUserIds.forEach((uid) => userIdsToValidate.add(uid));
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
    if (dto.editingAccess !== undefined) {
      pkg.editingAccess = dto.editingAccess;
    }
    if (dto.editingUserIds !== undefined) {
      pkg.editingUserIds = dto.editingUserIds;
    }

    const saved = await this.packagesRepository.save(pkg);
    return this.findOne(saved.id);
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
    if (dto.previewImage !== undefined) pkg.previewImage = dto.previewImage;

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
        `Package ${packageId} was saved but its room was not notified: ${errorMessage(
          error,
        )}`,
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
        message: 'Slug пакета workshop нельзя изменить: создайте новую запись',
      });
    }
    const roomId = pkg.room.id;

    let outcome: SlugRenameOutcome;
    try {
      outcome = await this.packagesRepository.manager.transaction((manager) =>
        this.rewriteRevisionsAndSwapSlug(manager, pkg, nextSlug, dto, roomId),
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Package ${pkg.id} slug rewrite failed: ${errorMessage(error)}`,
      );
      throw new InternalServerErrorException(
        {
          code: 'slug_rewrite_failed',
          message: 'Не удалось переписать ссылки на пакет',
        },
        { cause: error },
      );
    }

    await outcome.rewrite?.commit();
    for (const packageId of outcome.rewrittenIds) {
      await this.delivery
        .invalidatePackage(packageId)
        .catch((cause) =>
          this.logger.warn(
            `artifact invalidation failed: ${errorMessage(cause)}`,
          ),
        );
    }
    if (outcome.rewrittenIds.length > 0) {
      try {
        await this.dispatcher.packagesChanged(outcome.rewrittenIds);
      } catch (cause) {
        this.logger.warn(
          `Package ${pkg.id} was renamed but its room was not notified: ${String(
            cause,
          )}`,
        );
      }
    }
    if (outcome.enabledChanged) {
      await this.notifyEnabledChanged(pkg.id);
    }
    return this.findOne(pkg.id);
  }

  /**
   * Swaps the slug and rewrites every revision whose bytes reference it.
   *
   * Runs inside the caller's transaction: the row lock, the advisory slug locks
   * and the publish locks all have to be held while the bytes move, or a
   * concurrent publish could write a revision that still points at the old
   * directory. The rewrite handle goes back to the caller so the backups are
   * only dropped once the transaction commits; a failure after the rewrite
   * restores them here instead of leaving that bookkeeping to the caller.
   */
  private async rewriteRevisionsAndSwapSlug(
    manager: EntityManager,
    pkg: ScriptingPackage,
    nextSlug: string,
    dto: UpdateScriptingPackageDto,
    roomId: number,
  ): Promise<SlugRenameOutcome> {
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
      const enabledChanged = await this.preparePackageUpdate(current, dto);
      await packages.save(current);
      return { rewrite: null, rewrittenIds: [], enabledChanged };
    }
    const lockKeys = [
      `package_slug:room:${roomId}:${oldSlug}`,
      `package_slug:room:${roomId}:${nextSlug}`,
    ].sort();
    for (const key of lockKeys) {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    }
    const live = await packages.findOne({
      where: { slug: nextSlug, room: { id: roomId } },
    });
    if (live && live.id !== pkg.id) {
      throw packageSlugTaken(nextSlug);
    }
    const dependents =
      (await this.delivery.findDependentRoomPackages(pkg.id)) ?? [];
    if (dependents.length > 0 && dto.confirmSlugRename !== true) {
      const rows = await packages.find({
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

    return this.locks.runWithPublishLocks(
      [pkg.id, ...dependents.map((row) => row.packageId)],
      async () => {
        const revisions = manager.getRepository(ScriptingPackageRevision);
        const targets: RevisionTarget[] = [];
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

        const rewrite = await this.storage.beginRewrite(
          targets,
          (filepath, data) =>
            rewriteSlugReferences(filepath, data, oldSlug, nextSlug),
        );
        try {
          const rewritten = new Map<number, PackageFileEntry[]>();
          for (const { target, files } of rewrite.results) {
            const row = await revisions.findOneOrFail({
              where: {
                package: { id: target.packageId },
                revision: target.revision,
              },
            });
            // A draft declares only the files uploaded so far: keep that
            // set and refresh the hashes of the files that are on disk.
            rewritten.set(
              row.id,
              target.kind === 'published'
                ? files
                : this.mergeRevisionFiles(row.files ?? [], files),
            );
          }

          const enabledChanged = await this.preparePackageUpdate(pkg, dto);
          pkg.slug = nextSlug;
          await packages.save(pkg);
          for (const [id, files] of rewritten) {
            await revisions.update({ id }, { files });
          }
          return {
            rewrite,
            rewrittenIds: [
              ...new Set(targets.map((target) => target.packageId)),
            ].sort((a, b) => a - b),
            enabledChanged,
          };
        } catch (error) {
          await rewrite.abort();
          throw error;
        }
      },
    );
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
      load: pinnedPackageLoader(this.revisionsRepository, this.storage),
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

  /**
   * A room package may reference files of another package by absolute path
   * (`res://packages/<id>/...`), and the runtime keeps those references
   * pointing into the referenced package's own directory. Deleting a package
   * whose files are still referenced would therefore break every enabled
   * dependent on its next reload, so the delete is refused while one exists.
   */
  private async assertNoEnabledDependents(
    packageId: number,
    /**
     * Package ids being deleted in the same room cascade. Dependents in this
     * set cannot block the delete — they are removed in the same sweep.
     */
    cascadeRoomPackageIds?: ReadonlySet<number>,
  ): Promise<void> {
    const dependents = await this.delivery.findDependentRoomPackages(packageId);
    const relevant = cascadeRoomPackageIds
      ? dependents.filter(
          (dependent) => !cascadeRoomPackageIds.has(dependent.packageId),
        )
      : dependents;
    if (relevant.length === 0) {
      return;
    }
    const rows = await this.packagesRepository.find({
      where: { id: In(relevant.map((dependent) => dependent.packageId)) },
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
  /**
   * Deletes every scripting package that belongs to `roomId`, reusing
   * {@link remove} so revisions, disk files and runtime notify stay consistent.
   * Same-room enabled dependents do not block: they are part of this cascade.
   */
  async removeAllInRoom(roomId: number): Promise<void> {
    const packages = await this.packagesRepository.find({
      where: { room: { id: roomId } },
      select: ['id'],
    });
    if (packages.length === 0) {
      return;
    }
    const cascadeRoomPackageIds = new Set(packages.map((pkg) => pkg.id));
    for (const pkg of packages) {
      await this.remove(pkg.id, { cascadeRoomPackageIds });
    }
  }

  async remove(
    id: number,
    options?: { cascadeRoomPackageIds?: ReadonlySet<number> },
  ): Promise<void> {
    await this.assertNoEnabledDependents(id, options?.cascadeRoomPackageIds);
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
        `ScriptingPackage ${id} was deleted but its files were not removed: ${errorMessage(
          error,
        )}`,
      );
    }
    if (roomId !== null) {
      try {
        this.dispatcher.packageRemoved(id, roomId);
      } catch (error) {
        this.logger.warn(
          `Package ${id} was deleted but its room was not notified: ${errorMessage(
            error,
          )}`,
        );
      }
    }
  }
}
