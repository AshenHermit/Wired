import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import path from 'path';
import {
  WorkshopListing,
  WorkshopPackageMetadata,
  WorkshopPackageSummary,
  WorkshopPublishResult,
} from '@wired-io/shared';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { User } from 'src/database/entities/user.entity';
import { normalizeTags } from './package-tags';
import { PackageRevisionsService } from './package-revisions.service';
import { ScriptingPackagesService } from './scripting-packages.service';

const WORKSHOP_SELECT = `SELECT p.id, p.slug, p.name, p.version, p.description, p.tags,
       a.id AS "authorId", a.name AS "authorName", a.email AS "authorEmail",
       a.picture AS "authorPicture", a.service AS "authorService",
       r.revision, r."publishedAt", p."updatedAt",
       COUNT(*) OVER() AS total
FROM scripting_package p
LEFT JOIN "user" a ON a.id = p."authorId"
JOIN LATERAL (
  SELECT revision, "publishedAt" FROM scripting_package_revision
  WHERE "packageId" = p.id AND status = 'published'
    AND "publishedAt" IS NOT NULL
  ORDER BY revision DESC LIMIT 1
) r ON TRUE`;

const LIST_SQL = `${WORKSHOP_SELECT}
WHERE p."roomId" IS NULL
  AND ($1 = '' OR p.name ILIKE $1 OR p.slug ILIKE $1 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p.tags) AS t(tag) WHERE t.tag ILIKE $1))
ORDER BY r."publishedAt" DESC, p.id DESC
LIMIT $2 OFFSET $3`;

const LOOKUP_SQL = `${WORKSHOP_SELECT}
WHERE p."roomId" IS NULL AND p.slug = $1
LIMIT 1`;

const SUMMARY_SQL = `${WORKSHOP_SELECT}
WHERE p.id = $1
LIMIT 1`;

/** Files whose text may contain `res://packages/<slug>/` self references. */
const FORK_TEXT_EXTENSIONS = new Set(['.gd', '.tscn', '.tres', '.import']);

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

/**
 * Rewrites only whole-slug self references: `res://packages/hero/` must not
 * touch `res://packages/hero_controller/`. Binary files are copied as is.
 */
export function rewriteForkSlug(
  filepath: string,
  data: Buffer,
  oldSlug: string,
  newSlug: string,
): Buffer {
  const ext = path.posix.extname(filepath).toLowerCase();
  if (!FORK_TEXT_EXTENSIONS.has(ext)) return data;
  const text = data.toString('utf8');
  const needle = `res://packages/${oldSlug}/`;
  if (!text.includes(needle)) return data;
  return Buffer.from(
    text.split(needle).join(`res://packages/${newSlug}/`),
    'utf8',
  );
}

type WorkshopRow = {
  id: number;
  slug: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  authorId: number | null;
  authorName: string;
  authorEmail: string;
  authorPicture: string;
  authorService: 'email' | 'google' | 'vk' | 'yandex' | 'github';
  revision: number;
  publishedAt: Date;
  updatedAt: Date;
  total: string;
};

@Injectable()
export class PackageWorkshopService {
  private readonly logger = new Logger(PackageWorkshopService.name);

  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository: Repository<ScriptingPackage>,
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisionsRepository: Repository<ScriptingPackageRevision>,
    private readonly packagesService: ScriptingPackagesService,
    private readonly revisionsService: PackageRevisionsService,
  ) {}

  async list(query: {
    q?: string;
    limit?: number;
    offset?: number;
  }): Promise<WorkshopListing> {
    // Query-string input is unvalidated: `?q=a&q=b` arrives as an array and
    // `?limit=abc` as `NaN`. A non-finite `LIMIT`/`OFFSET` is a Postgres error,
    // and a fractional one (`?limit=2.5`) is rejected as `22P02`, so both are
    // truncated/clamped before they reach the query.
    const q = (typeof query.q === 'string' ? query.q : '')
      .trim()
      .toLowerCase()
      .slice(0, 64);
    const pattern = q ? `%${q}%` : '';
    const limit = Number.isFinite(query.limit)
      ? Math.min(100, Math.max(1, Math.trunc(query.limit as number)))
      : 50;
    const offset = Number.isFinite(query.offset)
      ? Math.max(0, Math.trunc(query.offset as number))
      : 0;

    const rows: WorkshopRow[] = await this.packagesRepository.query(LIST_SQL, [
      pattern,
      limit,
      offset,
    ]);

    return {
      items: rows.map((row) => this.toSummary(row)),
      total: rows[0] ? Number(rows[0].total) : 0,
    };
  }

  async lookup(
    slug: string,
  ): Promise<{ package: WorkshopPackageSummary | null }> {
    const normalized = this.packagesService.normalizeSlug(slug);
    const rows: WorkshopRow[] = await this.packagesRepository.query(
      LOOKUP_SQL,
      [normalized],
    );
    return { package: rows[0] ? this.toSummary(rows[0]) : null };
  }

  /**
   * Publishes a room package into the workshop: the global record is created
   * on first publish and receives a copy of the latest published revision on
   * every later one. The room package itself is never modified.
   */
  async publishToWorkshop(
    packageId: number,
    user: User,
    metadata: WorkshopPackageMetadata = {},
  ): Promise<WorkshopPublishResult> {
    const pkg = await this.loadPublishablePackage(packageId, user);
    await this.latestPublishedRevision(packageId);

    const existing = await this.findGlobalBySlug(pkg.slug);
    if (existing && existing.author?.id !== user.id) {
      throw new ConflictException({
        code: 'workshop_slug_taken',
        slug: pkg.slug,
        workshopPackage: await this.summaryById(existing.id),
      });
    }

    const values = {
      name: metadata.name ?? pkg.name,
      version: metadata.version ?? pkg.version,
      description: metadata.description ?? pkg.description,
      tags: normalizeTags(metadata.tags ?? pkg.tags ?? []),
    };

    let created: ScriptingPackage | undefined;
    let target = existing;
    if (!target) {
      created = await this.packagesService.createGlobalRecord({
        slug: pkg.slug,
        ...values,
        author: user,
      });
      target = created;
    }

    try {
      await this.revisionsService.publishCopiedRevision({
        sourcePackageId: packageId,
        targetPackageId: target.id,
      });
    } catch (error) {
      if (created) {
        await this.rollbackCreatedPackage(created.id, { tombstone: false });
      }
      throw this.toCopyError(error);
    }

    // The copy runs first so a failed copy leaves the metadata of an existing
    // record exactly as it was.
    if (!created) {
      await this.packagesService.update(target.id, values);
    }

    return {
      mode: created ? 'created' : 'updated',
      package: await this.summaryById(target.id),
    };
  }

  /**
   * Forks a room package under a new slug. The copy stays in the same room and
   * keeps the original parent, so the new package is a sibling of the source.
   */
  async forkToWorkshop(
    packageId: number,
    user: User,
    newSlugRaw: string,
  ): Promise<ScriptingPackage> {
    const pkg = await this.loadPublishablePackage(packageId, user);
    await this.latestPublishedRevision(packageId);

    const newSlug = this.packagesService.normalizeSlug(newSlugRaw);
    const available = await this.packagesService.checkSlugAvailability(
      newSlug,
      pkg.room!.id,
    );
    if (!available.available || !available.global.available) {
      throw new ConflictException({ code: 'slug_taken', slug: newSlug });
    }

    const created = await this.packagesService.create(
      {
        slug: newSlug,
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        tags: pkg.tags,
        authorId: user.id,
        roomId: pkg.room!.id,
        ...(pkg.parentPackage ? { parentPackageId: pkg.parentPackage.id } : {}),
      },
      user,
    );

    try {
      await this.revisionsService.publishCopiedRevision({
        sourcePackageId: packageId,
        targetPackageId: created.id,
        transformFile: (filepath, data) =>
          rewriteForkSlug(filepath, data, pkg.slug, newSlug),
      });
    } catch (error) {
      await this.rollbackCreatedPackage(created.id);
      throw this.toCopyError(error);
    }

    return this.packagesService.findOne(created.id);
  }

  /** Adds a workshop record to a room as an independent copy. */
  async addToRoom(
    workshopPackageId: number,
    roomId: number,
    user: User,
  ): Promise<ScriptingPackage> {
    const source = await this.packagesService.findOne(workshopPackageId);
    if (source.room) {
      throw new BadRequestException({
        code: 'package_not_in_workshop',
        message: 'Добавить в комнату можно только пакет из workshop',
      });
    }
    await this.latestPublishedRevision(workshopPackageId);

    // `create` checks the room rights and the room slug scope itself.
    const created = await this.packagesService.create(
      {
        slug: source.slug,
        name: source.name,
        version: source.version,
        description: source.description,
        tags: source.tags,
        authorId: user.id,
        roomId,
        parentPackageId: source.id,
      },
      user,
    );

    try {
      await this.revisionsService.publishCopiedRevision({
        sourcePackageId: workshopPackageId,
        targetPackageId: created.id,
      });
    } catch (error) {
      await this.rollbackCreatedPackage(created.id);
      throw this.toCopyError(error);
    }

    return this.packagesService.findOne(created.id);
  }

  /**
   * Copy flows run outside a transaction, so a failure has to compensate the
   * package row they created. Two concurrent copies of the same package race
   * on the revision number; the unique violation is a client conflict, not a
   * server error.
   */
  private toCopyError(error: unknown): unknown {
    if (isUniqueViolation(error)) {
      return new ConflictException({
        code: 'publish_conflict',
        message: 'Пакет уже публикуется, повторите попытку',
      });
    }
    return error;
  }

  /** A failed rollback must not replace the error of the copy itself. */
  private async rollbackCreatedPackage(
    packageId: number,
    options?: { tombstone?: boolean },
  ): Promise<void> {
    try {
      await this.packagesService.remove(packageId, options);
    } catch (error) {
      this.logger.warn(
        `Package ${packageId} copy rollback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Copy sources are always room packages and the caller needs rights there:
   * a workshop record is published only by being copied from a room.
   */
  private async loadPublishablePackage(
    packageId: number,
    user: User,
  ): Promise<ScriptingPackage> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId },
      relations: [
        'author',
        'parentPackage',
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
    if (!pkg.room) {
      throw new ConflictException({
        code: 'package_not_in_room',
        message: 'Публиковать в workshop можно только пакет комнаты',
      });
    }

    const isAuthor = pkg.author?.id === user.id;
    const isRoomMember =
      pkg.room.author?.id === user.id ||
      (pkg.room.contributors?.some(
        (contributor) => contributor.id === user.id,
      ) ??
        false);
    if (!isAuthor && !isRoomMember) {
      throw new ForbiddenException(
        'You are not allowed to publish this package',
      );
    }
    return pkg;
  }

  private async latestPublishedRevision(
    packageId: number,
  ): Promise<ScriptingPackageRevision> {
    const revision = await this.revisionsRepository.findOne({
      where: { package: { id: packageId }, status: 'published' },
      order: { revision: 'DESC' },
    });
    if (!revision) {
      throw new ConflictException({
        code: 'package_not_published',
        message: 'Сначала опубликуйте пакет',
      });
    }
    return revision;
  }

  private findGlobalBySlug(slug: string): Promise<ScriptingPackage | null> {
    return this.packagesRepository.findOne({
      where: { slug, room: IsNull() },
      relations: ['author'],
    });
  }

  private async summaryById(id: number): Promise<WorkshopPackageSummary> {
    const rows: WorkshopRow[] = await this.packagesRepository.query(
      SUMMARY_SQL,
      [id],
    );
    if (!rows[0]) {
      throw new NotFoundException(`Workshop package with id=${id} not found`);
    }
    return this.toSummary(rows[0]);
  }

  private toSummary(row: WorkshopRow): WorkshopPackageSummary {
    const summary: WorkshopPackageSummary = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      version: row.version,
      description: row.description,
      tags: row.tags,
      revision: row.revision,
      publishedAt: row.publishedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    if (row.authorId !== null) {
      summary.author = {
        id: row.authorId,
        name: row.authorName,
        email: row.authorEmail,
        picture: row.authorPicture,
        service: row.authorService,
      };
    }
    return summary;
  }
}
