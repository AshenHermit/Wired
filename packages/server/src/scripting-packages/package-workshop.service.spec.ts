import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackagesService } from './scripting-packages.service';
import { PackageWorkshopService } from './package-workshop.service';

type WorkshopRow = {
  id: number;
  slug: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  authorId: number | null;
  authorName: string | null;
  authorEmail: string | null;
  authorPicture: string | null;
  authorService: string | null;
  revision: number;
  publishedAt: Date;
  updatedAt: Date;
  total: string;
};

const row: WorkshopRow = {
  id: 1,
  slug: 'hero',
  name: 'Hero',
  version: '1.0',
  description: 'd',
  tags: ['2d'],
  authorId: 7,
  authorName: 'Ann',
  authorEmail: 'a@b.c',
  authorPicture: 'p',
  authorService: 'google',
  revision: 3,
  publishedAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  total: '1',
};

function makeService(repository: { query: jest.Mock }) {
  const packagesService = {
    normalizeSlug: jest.fn((slug: string) => slug.trim()),
  };
  return new PackageWorkshopService(
    repository as unknown as Repository<ScriptingPackage>,
    packagesService as unknown as ScriptingPackagesService,
  );
}

/** The SQL text a mocked repository received on a given call. */
function sqlOf(query: jest.Mock, call = 0): string {
  return String((query.mock.calls[call] as [string, unknown[]])[0]);
}

/** The parameter array a mocked repository received on a given call. */
function paramsOf(query: jest.Mock, call = 0): unknown[] {
  return (query.mock.calls[call] as [string, unknown[]])[1];
}

describe('PackageWorkshopService', () => {
  it('normalizes the query and clamps pagination', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await service.list({ q: '  HERO  ', limit: 500, offset: -3 });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ILIKE'), [
      '%hero%',
      100,
      0,
    ]);
  });

  it('uses an empty pattern and default pagination without a query', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await expect(service.list({})).resolves.toEqual({ items: [], total: 0 });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ILIKE'), [
      '',
      50,
      0,
    ]);
  });

  it('falls back to defaults when pagination is not a finite number', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await service.list({ limit: Number.NaN, offset: Number.NaN });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ILIKE'), [
      '',
      50,
      0,
    ]);
  });

  it('clamps out-of-range pagination', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await service.list({ limit: 0, offset: -5 });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ILIKE'), [
      '',
      1,
      0,
    ]);
  });

  it('truncates fractional pagination to integers', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await service.list({ limit: 2.5, offset: 1.5 });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ILIKE'), [
      '',
      2,
      1,
    ]);
    expect(paramsOf(query)).toEqual(['', 2, 1]);
  });

  it('treats a non-string query as absent', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await expect(service.list({ q: ['a', 'b'] as never })).resolves.toEqual({
      items: [],
      total: 0,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ILIKE'), [
      '',
      50,
      0,
    ]);
  });

  it('lists only published global packages and keeps the pagination clause', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await service.list({});

    const sql = sqlOf(query);
    expect(sql).toContain('p."roomId" IS NULL');
    expect(sql).toContain("status = 'published'");
    expect(sql).toContain('AND "publishedAt" IS NOT NULL');
    expect(sql).toContain('jsonb_array_elements_text');
    expect(sql.trimEnd().endsWith('LIMIT $2 OFFSET $3')).toBe(true);
  });

  it('maps a row into a workshop summary with a full author', async () => {
    const query = jest.fn(() => Promise.resolve([row]));

    const result = await makeService({ query }).list({});

    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual({
      id: 1,
      slug: 'hero',
      name: 'Hero',
      version: '1.0',
      description: 'd',
      tags: ['2d'],
      revision: 3,
      publishedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      author: {
        id: 7,
        name: 'Ann',
        email: 'a@b.c',
        picture: 'p',
        service: 'google',
      },
    });
  });

  it('omits the author when the package has none', async () => {
    const anonymous = {
      ...row,
      authorId: null,
      authorName: null,
      authorEmail: null,
      authorPicture: null,
      authorService: null,
    };

    const result = await makeService({
      query: jest.fn(() => Promise.resolve([anonymous])),
    }).list({});

    expect(result.items[0]).not.toHaveProperty('author');
  });

  it('returns null from lookup when the slug is not published', async () => {
    const query = jest.fn(() => Promise.resolve([]));

    await expect(makeService({ query }).lookup('hero')).resolves.toEqual({
      package: null,
    });
  });

  it('looks a single global package up by its normalized slug', async () => {
    const query = jest.fn(() => Promise.resolve([row]));
    const service = makeService({ query });

    await expect(service.lookup('  hero ')).resolves.toEqual({
      package: {
        id: 1,
        slug: 'hero',
        name: 'Hero',
        version: '1.0',
        description: 'd',
        tags: ['2d'],
        revision: 3,
        publishedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        author: {
          id: 7,
          name: 'Ann',
          email: 'a@b.c',
          picture: 'p',
          service: 'google',
        },
      },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('p.slug = $1'), [
      'hero',
    ]);

    const sql = sqlOf(query);
    expect(sql).toContain('p."roomId" IS NULL');
    expect(sql).toContain("status = 'published'");
    expect(sql).toContain('AND "publishedAt" IS NOT NULL');
    expect(sql).toContain('p.slug = $1');
    expect(sql.trimEnd().endsWith('LIMIT 1')).toBe(true);
    expect(paramsOf(query)).toEqual(['hero']);
  });
});
