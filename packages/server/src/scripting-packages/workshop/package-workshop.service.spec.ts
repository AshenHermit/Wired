import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { User } from 'src/database/entities/user.entity';
import { PackageRevisionsService } from '../publish/package-revisions.service';
import { ScriptingPackagesService } from '../scripting-packages.service';
import {
  PackageWorkshopService,
  rewriteForkSlug,
} from './package-workshop.service';

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
    {} as Repository<ScriptingPackageRevision>,
    packagesService as unknown as ScriptingPackagesService,
    {} as PackageRevisionsService,
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

  it('projects the author down to what every reader may see', async () => {
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
      // The listing answers anonymous callers: no email, no auth provider.
      author: {
        id: 7,
        name: 'Ann',
        picture: 'p',
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
          picture: 'p',
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

describe('PackageWorkshopService copies', () => {
  const user = { id: 7, name: 'Ann', email: 'a@b.c' } as User;

  type CopyArgs = {
    sourcePackageId: number;
    targetPackageId: number;
    transformFile?: (filepath: string, data: Buffer) => Buffer;
  };

  function makeFlow() {
    const packagesService = {
      normalizeSlug: jest.fn((slug: string) => slug.trim()),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(() => Promise.resolve(undefined)),
      createGlobalRecord: jest.fn(),
      checkSlugAvailability: jest.fn(),
      remove: jest.fn(),
    };
    const revisionsService = {
      publishCopiedRevision: jest.fn((args: CopyArgs) => Promise.resolve(args)),
    };
    const repository = {
      query: jest.fn(() => Promise.resolve([row])),
      findOne: jest.fn(),
    };
    const revisionsRepository = { findOne: jest.fn() };

    const service = new PackageWorkshopService(
      repository as unknown as Repository<ScriptingPackage>,
      revisionsRepository as unknown as Repository<ScriptingPackageRevision>,
      packagesService as unknown as ScriptingPackagesService,
      revisionsService as unknown as PackageRevisionsService,
    );
    return {
      service,
      repository,
      revisionsRepository,
      packagesService,
      revisionsService,
    };
  }

  function roomPackage(
    overrides: Partial<ScriptingPackage> = {},
  ): ScriptingPackage {
    return {
      id: 5,
      slug: 'hero',
      name: 'Hero',
      version: '1.0',
      description: 'd',
      tags: ['2d'],
      author: { id: user.id } as User,
      room: {
        id: 5,
        author: { id: user.id },
        contributors: [],
      } as unknown as Room,
      ...overrides,
    } as ScriptingPackage;
  }

  /** The thrown HTTP error of a call that must reject. */
  async function rejection(promise: Promise<unknown>): Promise<HttpException> {
    try {
      await promise;
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('expected the call to reject');
  }

  it('creates a global record with the published snapshot', async () => {
    const flow = makeFlow();
    flow.repository.findOne
      .mockResolvedValueOnce(roomPackage())
      .mockResolvedValueOnce(null);
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.packagesService.createGlobalRecord.mockResolvedValue({
      id: 20,
      slug: 'hero',
    });
    flow.repository.query.mockResolvedValue([{ ...row, id: 20 }]);

    const result = await flow.service.publishToWorkshop(5, user);

    expect(flow.packagesService.createGlobalRecord).toHaveBeenCalledWith({
      slug: 'hero',
      name: 'Hero',
      version: '1.0',
      description: 'd',
      tags: ['2d'],
      author: user,
    });
    expect(flow.revisionsService.publishCopiedRevision).toHaveBeenCalledWith({
      sourcePackageId: 5,
      targetPackageId: 20,
    });
    expect(flow.packagesService.update).not.toHaveBeenCalled();
    expect(flow.packagesService.remove).not.toHaveBeenCalled();
    expect(result.mode).toBe('created');
    expect(result.package).toMatchObject({ id: 20, slug: 'hero', revision: 3 });
    expect(flow.repository.query).toHaveBeenCalledWith(
      expect.stringContaining('p.id = $1'),
      [20],
    );
  });

  it('updates the record when the caller is its author, after the copy', async () => {
    const flow = makeFlow();
    flow.repository.findOne
      .mockResolvedValueOnce(roomPackage())
      .mockResolvedValueOnce({ id: 20, slug: 'hero', author: { id: user.id } });
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.repository.query.mockResolvedValue([{ ...row, id: 20 }]);

    const result = await flow.service.publishToWorkshop(5, user, {
      name: 'Hero 2',
      tags: [' 3D '],
    });

    expect(flow.packagesService.createGlobalRecord).not.toHaveBeenCalled();
    expect(flow.revisionsService.publishCopiedRevision).toHaveBeenCalledWith({
      sourcePackageId: 5,
      targetPackageId: 20,
    });
    expect(flow.packagesService.update).toHaveBeenCalledWith(20, {
      name: 'Hero 2',
      version: '1.0',
      description: 'd',
      tags: ['3d'],
    });
    expect(
      flow.revisionsService.publishCopiedRevision.mock.invocationCallOrder[0],
    ).toBeLessThan(flow.packagesService.update.mock.invocationCallOrder[0]);
    expect(result.mode).toBe('updated');
    expect(result.package).toMatchObject({ id: 20 });
  });

  it('refuses to overwrite another author record', async () => {
    const flow = makeFlow();
    flow.repository.findOne
      .mockResolvedValueOnce(roomPackage())
      .mockResolvedValueOnce({ id: 20, slug: 'hero', author: { id: 99 } });
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.repository.query.mockResolvedValue([{ ...row, id: 20 }]);

    const error = await rejection(flow.service.publishToWorkshop(5, user));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      code: 'workshop_slug_taken',
      slug: 'hero',
      workshopPackage: { id: 20, slug: 'hero' },
    });
    expect(flow.revisionsService.publishCopiedRevision).not.toHaveBeenCalled();
    expect(flow.packagesService.update).not.toHaveBeenCalled();
  });

  it('reports the record that won the creation race', async () => {
    const flow = makeFlow();
    flow.repository.findOne
      .mockResolvedValueOnce(roomPackage())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 20, slug: 'hero', author: { id: 99 } });
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.packagesService.createGlobalRecord.mockRejectedValue(
      new ConflictException({ code: 'slug_taken', slug: 'hero' }),
    );
    flow.repository.query.mockResolvedValue([{ ...row, id: 20 }]);

    const error = await rejection(flow.service.publishToWorkshop(5, user));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      code: 'workshop_slug_taken',
      slug: 'hero',
      workshopPackage: { id: 20, slug: 'hero' },
    });
    expect(flow.revisionsService.publishCopiedRevision).not.toHaveBeenCalled();
  });

  it('rethrows a slug_taken that no global record explains', async () => {
    const flow = makeFlow();
    flow.repository.findOne
      .mockResolvedValueOnce(roomPackage())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    const failure = new ConflictException({
      code: 'slug_taken',
      slug: 'hero',
    });
    flow.packagesService.createGlobalRecord.mockRejectedValue(failure);

    await expect(flow.service.publishToWorkshop(5, user)).rejects.toBe(failure);
  });

  it('rejects publishing a package without a published revision', async () => {
    const flow = makeFlow();
    flow.repository.findOne.mockResolvedValueOnce(roomPackage());
    flow.revisionsRepository.findOne.mockResolvedValue(null);

    const error = await rejection(flow.service.publishToWorkshop(5, user));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      code: 'package_not_published',
    });
    expect(flow.packagesService.createGlobalRecord).not.toHaveBeenCalled();
  });

  it('rejects publishing a workshop record from the workshop', async () => {
    const flow = makeFlow();
    flow.repository.findOne.mockResolvedValueOnce(roomPackage({ room: null }));

    const error = await rejection(flow.service.publishToWorkshop(5, user));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: 'package_not_in_room' });
    expect(flow.packagesService.createGlobalRecord).not.toHaveBeenCalled();
  });

  it('rejects publishing by a user outside the package room', async () => {
    const flow = makeFlow();
    flow.repository.findOne.mockResolvedValueOnce(
      roomPackage({
        author: { id: 99 } as User,
        room: { id: 5, author: { id: 99 }, contributors: [{ id: 98 }] } as Room,
      }),
    );

    const error = await rejection(flow.service.publishToWorkshop(5, user));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(flow.packagesService.createGlobalRecord).not.toHaveBeenCalled();
  });

  it('rejects publishing by the package author who is no longer in the room', async () => {
    const flow = makeFlow();
    flow.repository.findOne.mockResolvedValueOnce(
      roomPackage({
        author: { id: user.id } as User,
        room: { id: 5, author: { id: 99 }, contributors: [{ id: 98 }] } as Room,
      }),
    );

    const error = await rejection(flow.service.publishToWorkshop(5, user));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(flow.packagesService.createGlobalRecord).not.toHaveBeenCalled();
  });

  it('rejects forking by the package author who is no longer in the room', async () => {
    const flow = makeFlow();
    flow.repository.findOne.mockResolvedValueOnce(
      roomPackage({
        author: { id: user.id } as User,
        room: { id: 5, author: { id: 99 }, contributors: [{ id: 98 }] } as Room,
      }),
    );

    const error = await rejection(
      flow.service.forkToWorkshop(5, user, 'hero2'),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(flow.packagesService.create).not.toHaveBeenCalled();
  });

  it('forks with a new slug and keeps the parent', async () => {
    const flow = makeFlow();
    flow.repository.findOne.mockResolvedValueOnce(
      roomPackage({ parentPackage: { id: 40 } as ScriptingPackage }),
    );
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.packagesService.checkSlugAvailability.mockResolvedValue({
      slug: 'hero2',
      available: true,
      global: { available: true },
    });
    flow.packagesService.create.mockResolvedValue({ id: 30, slug: 'hero2' });
    flow.packagesService.findOne.mockResolvedValue({
      id: 30,
      slug: 'hero2',
      room: { id: 5 },
    });

    const result = await flow.service.forkToWorkshop(5, user, ' hero2 ');

    expect(flow.packagesService.checkSlugAvailability).toHaveBeenCalledWith(
      'hero2',
      5,
    );
    expect(flow.packagesService.create).toHaveBeenCalledWith(
      {
        slug: 'hero2',
        name: 'Hero',
        version: '1.0',
        description: 'd',
        tags: ['2d'],
        roomId: 5,
        parentPackageId: 40,
      },
      user,
    );
    const copy = flow.revisionsService.publishCopiedRevision.mock.calls[0][0];
    expect(copy.sourcePackageId).toBe(5);
    expect(copy.targetPackageId).toBe(30);
    expect(
      copy.transformFile!(
        'main.gd',
        Buffer.from(
          'res://packages/hero/main.gd res://packages/hero_controller/x.gd',
        ),
      ).toString('utf8'),
    ).toBe('res://packages/hero2/main.gd res://packages/hero_controller/x.gd');
    expect(flow.packagesService.remove).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 30, slug: 'hero2', room: { id: 5 } });
  });

  it('rewrites only whole-slug self references', () => {
    const data = Buffer.from(
      'res://packages/hero/main.gd res://packages/hero_controller/x.gd',
    );

    const out = rewriteForkSlug('main.gd', data, 'hero', 'hero2');

    expect(out.toString('utf8')).toContain('res://packages/hero2/main.gd');
    expect(out.toString('utf8')).toContain(
      'res://packages/hero_controller/x.gd',
    );
    expect(rewriteForkSlug('main.bin', data, 'hero', 'hero2')).toBe(data);
  });

  it('rejects a fork slug taken in the room or globally', async () => {
    const availability = [
      {
        slug: 'hero2',
        available: false,
        reason: 'taken',
        global: { available: true },
      },
      {
        slug: 'hero2',
        available: true,
        global: { available: false, reason: 'taken' },
      },
    ];

    for (const value of availability) {
      const flow = makeFlow();
      flow.repository.findOne.mockResolvedValueOnce(roomPackage());
      flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
      flow.packagesService.checkSlugAvailability.mockResolvedValue(value);

      const error = await rejection(
        flow.service.forkToWorkshop(5, user, 'hero2'),
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        code: 'slug_taken',
        slug: 'hero2',
      });
      expect(flow.packagesService.create).not.toHaveBeenCalled();
    }
  });

  it('removes the forked package when the copy fails', async () => {
    const flow = makeFlow();
    flow.repository.findOne.mockResolvedValueOnce(roomPackage());
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.packagesService.checkSlugAvailability.mockResolvedValue({
      slug: 'hero2',
      available: true,
      global: { available: true },
    });
    flow.packagesService.create.mockResolvedValue({ id: 30, slug: 'hero2' });
    const failure = new Error('copy_failed');
    flow.revisionsService.publishCopiedRevision.mockRejectedValue(failure);

    await expect(flow.service.forkToWorkshop(5, user, 'hero2')).rejects.toBe(
      failure,
    );

    expect(flow.packagesService.remove).toHaveBeenCalledTimes(1);
    const [removedId] = flow.packagesService.remove.mock.calls[0] as [number];
    expect(removedId).toBe(30);
  });

  it('adds a workshop record as an independent room copy', async () => {
    const flow = makeFlow();
    flow.packagesService.findOne
      .mockResolvedValueOnce({
        id: 20,
        slug: 'hero',
        name: 'Hero',
        version: '1.0',
        description: 'd',
        tags: ['2d'],
        room: null,
      })
      .mockResolvedValueOnce({ id: 31, slug: 'hero', room: { id: 9 } });
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 3 });
    flow.packagesService.create.mockResolvedValue({ id: 31, slug: 'hero' });

    const result = await flow.service.copyToRoom(20, 9, user);

    expect(flow.packagesService.create).toHaveBeenCalledWith(
      {
        slug: 'hero',
        name: 'Hero',
        version: '1.0',
        description: 'd',
        tags: ['2d'],
        roomId: 9,
        parentPackageId: 20,
      },
      user,
    );
    expect(flow.revisionsService.publishCopiedRevision).toHaveBeenCalledWith({
      sourcePackageId: 20,
      targetPackageId: 31,
    });
    expect(result).toEqual({ id: 31, slug: 'hero', room: { id: 9 } });
  });

  it('rejects adding a room package to another room', async () => {
    const flow = makeFlow();
    flow.packagesService.findOne.mockResolvedValueOnce(roomPackage());

    const error = await rejection(flow.service.copyToRoom(5, 9, user));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({
      code: 'package_not_in_workshop',
    });
    expect(flow.packagesService.create).not.toHaveBeenCalled();
  });

  it('deletes a fresh record when the copy fails', async () => {
    const flow = makeFlow();
    flow.repository.findOne
      .mockResolvedValueOnce(roomPackage())
      .mockResolvedValueOnce(null);
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.packagesService.createGlobalRecord.mockResolvedValue({
      id: 20,
      slug: 'hero',
    });
    const failure = new Error('copy_failed');
    flow.revisionsService.publishCopiedRevision.mockRejectedValue(failure);

    await expect(flow.service.publishToWorkshop(5, user)).rejects.toBe(failure);

    expect(flow.packagesService.remove.mock.calls[0]).toEqual([20]);
  });

  it('maps a duplicate revision on publish to a publish conflict', async () => {
    const flow = makeFlow();
    flow.repository.findOne
      .mockResolvedValueOnce(roomPackage())
      .mockResolvedValueOnce(null);
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.packagesService.createGlobalRecord.mockResolvedValue({
      id: 20,
      slug: 'hero',
    });
    flow.revisionsService.publishCopiedRevision.mockRejectedValue({
      code: '23505',
    });

    const error = await rejection(flow.service.publishToWorkshop(5, user));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: 'publish_conflict' });
    expect(flow.packagesService.remove).toHaveBeenCalledTimes(1);
  });

  it('maps a duplicate revision on fork to a publish conflict', async () => {
    const flow = makeFlow();
    flow.repository.findOne.mockResolvedValueOnce(roomPackage());
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.packagesService.checkSlugAvailability.mockResolvedValue({
      slug: 'hero2',
      available: true,
      global: { available: true },
    });
    flow.packagesService.create.mockResolvedValue({ id: 30, slug: 'hero2' });
    flow.revisionsService.publishCopiedRevision.mockRejectedValue({
      code: '23505',
    });

    const error = await rejection(
      flow.service.forkToWorkshop(5, user, 'hero2'),
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: 'publish_conflict' });
    expect(flow.packagesService.remove).toHaveBeenCalledTimes(1);
  });

  it('maps a duplicate revision when adding to a room to a publish conflict', async () => {
    const flow = makeFlow();
    flow.packagesService.findOne
      .mockResolvedValueOnce({ id: 20, slug: 'hero', room: null })
      .mockResolvedValueOnce({ id: 31, slug: 'hero' });
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 3 });
    flow.packagesService.create.mockResolvedValue({ id: 31, slug: 'hero' });
    flow.revisionsService.publishCopiedRevision.mockRejectedValue({
      code: '23505',
    });

    const error = await rejection(flow.service.copyToRoom(20, 9, user));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: 'publish_conflict' });
    expect(flow.packagesService.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps the publication error when the rollback fails', async () => {
    const flow = makeFlow();
    flow.repository.findOne
      .mockResolvedValueOnce(roomPackage())
      .mockResolvedValueOnce(null);
    flow.revisionsRepository.findOne.mockResolvedValue({ revision: 2 });
    flow.packagesService.createGlobalRecord.mockResolvedValue({
      id: 20,
      slug: 'hero',
    });
    const failure = new Error('copy_failed');
    flow.revisionsService.publishCopiedRevision.mockRejectedValue(failure);
    flow.packagesService.remove.mockRejectedValue(new Error('rollback_failed'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    try {
      await expect(flow.service.publishToWorkshop(5, user)).rejects.toBe(
        failure,
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('copy rollback failed'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('normalizes the tag query and clamps pagination', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await service.tags({ q: '  HERO  ', limit: 500, offset: -3 });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('jsonb_array_elements_text'),
      ['%hero%', 200, 0],
    );
  });

  it('uses an empty tag pattern and the tag pagination defaults', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await expect(service.tags({})).resolves.toEqual({ items: [], total: 0 });

    expect(query).toHaveBeenCalledWith(expect.anything(), ['', 100, 0]);
  });

  it('maps tag counts and total from Postgres strings to numbers', async () => {
    const query = jest.fn(() =>
      Promise.resolve([{ tag: '2d', count: '3', total: '2' }]),
    );
    const service = makeService({ query });

    await expect(service.tags({})).resolves.toEqual({
      items: [{ tag: '2d', count: 3 }],
      total: 2,
    });
  });

  it('falls back to tag defaults for non-finite and fractional paging', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await service.tags({ limit: Number.NaN, offset: Number.NaN });
    expect(paramsOf(query)).toEqual(['', 100, 0]);

    await service.tags({ limit: 2.5, offset: 1.5 });
    expect(paramsOf(query, 1)).toEqual(['', 2, 1]);
  });

  it('treats a non-string tag query as absent', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await service.tags({ q: ['a', 'b'] as never });

    expect(paramsOf(query)).toEqual(['', 100, 0]);
  });

  it('counts each package once per tag', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = makeService({ query });

    await service.tags({});

    expect(sqlOf(query)).toContain('COUNT(DISTINCT p.id)::int AS count');
    expect(sqlOf(query)).toContain('ORDER BY COUNT(DISTINCT p.id) DESC');
  });
});
