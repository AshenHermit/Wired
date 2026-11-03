import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkshopListing, WorkshopPackageSummary } from '@wired-io/shared';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
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
  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository: Repository<ScriptingPackage>,
    private readonly packagesService: ScriptingPackagesService,
  ) {}

  async list(query: {
    q?: string;
    limit?: number;
    offset?: number;
  }): Promise<WorkshopListing> {
    const q = (query.q ?? '').trim().toLowerCase().slice(0, 64);
    const pattern = q ? `%${q}%` : '';
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);

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
