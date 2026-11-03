import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { PackageFileEntry } from '@wired-io/shared';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AppConfigService } from 'src/config/config.service';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { PackageClosureResolver } from './package-closure-resolver';
import { sha256Hex } from './package-hash';
import { PackageStorageService } from './package-storage.service';

type PackageFixture = {
  id: number;
  name: string;
  slug: string;
  room: { id: number } | null;
};

type RevisionFixture = {
  packageId: number;
  revision: number;
  status: 'draft' | 'published' | 'discarded';
  files: PackageFileEntry[];
  publishedAt: Date | null;
};

describe('PackageClosureResolver', () => {
  let root: string;
  let storage: PackageStorageService;
  let revisionsRepository: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let packagesRepository: {
    find: jest.Mock;
  };
  let resolver: PackageClosureResolver;

  let packages: PackageFixture[];
  let revisions: RevisionFixture[];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wired-closure-'));
    storage = new PackageStorageService({
      storage: { packagesFilesDir: root, dir: root },
    } as unknown as AppConfigService);

    packages = [];
    revisions = [];

    revisionsRepository = {
      find: jest.fn((opts: { where: { status?: string } }) => {
        const status = opts.where.status;
        return revisions
          .filter((row) => status === undefined || row.status === status)
          .sort((a, b) => b.revision - a.revision)
          .map((row) => toRevisionRow(row, packageById(row.packageId)));
      }),
      createQueryBuilder: jest.fn(() => latestRevisionsQueryBuilder()),
      findOne: jest.fn(
        (opts: {
          where: {
            package: { id: number };
            revision?: number;
            status?: string;
          };
        }) => {
          const packageId = opts.where.package.id;
          const candidates = revisions.filter(
            (row) => row.packageId === packageId,
          );
          if (opts.where.revision !== undefined) {
            const row = candidates.find(
              (candidate) => candidate.revision === opts.where.revision,
            );
            return row ? toRevisionRow(row, packageById(packageId)) : null;
          }
          if (opts.where.status === 'published') {
            const published = candidates
              .filter((candidate) => candidate.status === 'published')
              .sort((a, b) => b.revision - a.revision);
            const row = published[0];
            return row ? toRevisionRow(row, packageById(packageId)) : null;
          }
          return null;
        },
      ),
    };

    packagesRepository = {
      find: jest.fn(() =>
        packages.map((pkg) => ({
          id: pkg.id,
          slug: pkg.slug,
          room: pkg.room,
        })),
      ),
    };

    resolver = new PackageClosureResolver(
      revisionsRepository as never,
      storage,
      packagesRepository as never,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function packageById(id: number): PackageFixture {
    const pkg = packages.find((candidate) => candidate.id === id);
    if (!pkg) {
      throw new Error(`package ${id} not defined in fixture`);
    }
    return pkg;
  }

  /**
   * Minimal stand-in for the TypeORM query builder that loads the newest
   * published revision of every package (DISTINCT ON `package.id`).
   */
  function latestRevisionsQueryBuilder() {
    const builder = {
      distinctOn: jest.fn(() => builder),
      innerJoinAndSelect: jest.fn(() => builder),
      leftJoinAndSelect: jest.fn(() => builder),
      where: jest.fn(() => builder),
      andWhere: jest.fn(() => builder),
      orderBy: jest.fn(() => builder),
      addOrderBy: jest.fn(() => builder),
      getMany: jest.fn(async () => {
        const rows = revisions
          .filter((row) => row.status === 'published' && row.publishedAt)
          .sort((a, b) => b.revision - a.revision);
        const seen = new Set<number>();
        const out: ScriptingPackageRevision[] = [];
        for (const row of rows) {
          if (seen.has(row.packageId)) {
            continue;
          }
          seen.add(row.packageId);
          out.push(toRevisionRow(row, packageById(row.packageId)));
        }
        return out;
      }),
    };
    return builder;
  }

  function toRevisionRow(
    row: RevisionFixture,
    pkg: PackageFixture,
  ): ScriptingPackageRevision {
    return {
      package: pkg as unknown as ScriptingPackage,
      revision: row.revision,
      status: row.status,
      files: row.files,
      publishedAt: row.publishedAt,
    } as unknown as ScriptingPackageRevision;
  }

  function definePackage(
    id: number,
    name: string,
    roomId: number | null,
    slug = String(id),
  ): void {
    packages.push({
      id,
      name,
      slug,
      room: roomId === null ? null : { id: roomId },
    });
  }

  async function writePublished(
    packageId: number,
    revision: number,
    files: Record<string, string | Buffer>,
    publishedAt = new Date('2026-10-30T00:00:00.000Z'),
  ): Promise<void> {
    const entries: PackageFileEntry[] = [];
    for (const [filepath, content] of Object.entries(files)) {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
      await storage.saveDraftFile(packageId, revision, filepath, data);
      entries.push({
        filepath,
        size: data.byteLength,
        sha256: sha256Hex(data),
      });
    }
    entries.sort((a, b) => a.filepath.localeCompare(b.filepath));
    await storage.publishRevision(packageId, revision, entries, async () => {
      // The database is mocked separately; commit is a no-op here.
    });
    revisions.push({
      packageId,
      revision,
      status: 'published',
      files: entries,
      publishedAt,
    });
  }

  /**
   * Builds a published fixture from a compact description: the first package
   * is the root, every package is published unless `published` narrows that
   * down. The root's `main.gd` references `reference`, so the closure can be
   * resolved end to end.
   */
  async function makeResolver(options: {
    packages: Array<{ id: number; slug: string; roomId?: number | null }>;
    published?: number[];
    reference: string;
  }): Promise<PackageClosureResolver> {
    for (const pkg of options.packages) {
      definePackage(pkg.id, `Package${pkg.id}`, pkg.roomId ?? null, pkg.slug);
    }
    const rootId = options.packages[0].id;
    const published =
      options.published ?? options.packages.map((pkg) => pkg.id);
    for (const id of published) {
      await writePublished(
        id,
        1,
        id === rootId
          ? { 'main.gd': `preload("${options.reference}")` }
          : { 'lib.gd': 'extends Node' },
      );
    }
    return resolver;
  }

  function internals() {
    return resolver as unknown as {
      maxFileCacheBytes: number;
      fileBytes: Map<string, Buffer>;
      fileCacheBytes: number;
      logger: Logger;
    };
  }

  describe('findDependentRoomPackages', () => {
    it('finds room packages that reference the published package transitively', async () => {
      definePackage(5, 'Library', null);
      definePackage(10, 'A', 7);
      definePackage(11, 'B', 7);
      await writePublished(10, 1, {
        'a.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(11, 1, {
        'b.gd': 'preload("res://packages/10/a.gd")',
      });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 10, roomId: 7, revision: 1 },
        { packageId: 11, roomId: 7, revision: 1 },
      ]);
    });

    it('loads only the newest published revision of every package', async () => {
      definePackage(5, 'Library', null);
      definePackage(10, 'A', 7);
      await writePublished(10, 1, {
        'a.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(10, 2, { 'a.gd': 'extends Node' });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await resolver.findDependentRoomPackages(5);

      expect(revisionsRepository.find).not.toHaveBeenCalled();
      const builder =
        revisionsRepository.createQueryBuilder.mock.results[0].value;
      expect(builder.distinctOn).toHaveBeenCalledWith(['package.id']);
      expect(builder.where).toHaveBeenCalledWith('revision.status = :status', {
        status: 'published',
      });
      expect(builder.andWhere).toHaveBeenCalledWith(
        'revision.publishedAt IS NOT NULL',
      );
    });

    it('only considers the latest published revision of a dependent', async () => {
      definePackage(5, 'Library', null);
      definePackage(10, 'A', 7);
      await writePublished(10, 1, {
        'a.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(10, 2, { 'a.gd': 'extends Node' });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([]);
    });

    it('does not fall back when the latest published revision has no publishedAt', async () => {
      definePackage(5, 'Library', null);
      definePackage(10, 'A', 7);
      await writePublished(10, 1, { 'a.gd': 'extends Node' });
      await writePublished(10, 2, {
        'a.gd': 'preload("res://packages/5/x.gd")',
      });
      const latest = revisions.find(
        (row) => row.packageId === 10 && row.revision === 2,
      );
      latest!.publishedAt = null;
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([]);
    });

    it('traverses through a global library to reach a room package', async () => {
      definePackage(5, 'Root', null);
      definePackage(12, 'GlobalBridge', null);
      definePackage(13, 'Game', 7);
      await writePublished(13, 1, {
        'a.gd': 'preload("res://packages/12/m.gd")',
      });
      await writePublished(12, 1, {
        'm.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 13, roomId: 7, revision: 1 },
      ]);
    });

    it('reaches a room package through a global bridge and prunes other rooms', async () => {
      definePackage(5, 'Library', 7);
      definePackage(12, 'GlobalBridge', null);
      definePackage(13, 'SameRoom', 7);
      definePackage(14, 'OtherRoom', 8);
      await writePublished(12, 1, {
        'm.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(13, 1, {
        'a.gd': 'preload("res://packages/12/m.gd")',
      });
      await writePublished(14, 1, {
        'b.gd': 'preload("res://packages/12/m.gd")',
      });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 13, roomId: 7, revision: 1 },
      ]);
    });

    it('does not include a global package that depends on the library', async () => {
      definePackage(5, 'Root', null);
      definePackage(12, 'GlobalConsumer', null);
      await writePublished(12, 1, {
        'm.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([]);
    });

    it('excludes a dependent from another room', async () => {
      definePackage(5, 'Library', 7);
      definePackage(10, 'SameRoom', 7);
      definePackage(11, 'OtherRoom', 8);
      await writePublished(10, 1, {
        'a.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(11, 1, {
        'b.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 10, roomId: 7, revision: 1 },
      ]);
    });

    it('returns a package reachable directly and transitively exactly once', async () => {
      definePackage(5, 'Library', null);
      definePackage(10, 'Direct', 7);
      definePackage(11, 'Transitive', 7);
      await writePublished(10, 1, {
        'a.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(11, 1, {
        'b.gd':
          'preload("res://packages/10/a.gd") preload("res://packages/5/x.gd")',
      });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 10, roomId: 7, revision: 1 },
        { packageId: 11, roomId: 7, revision: 1 },
      ]);
    });

    it('terminates on a dependency cycle', async () => {
      definePackage(5, 'Library', null);
      definePackage(10, 'A', 7);
      definePackage(11, 'B', 7);
      await writePublished(10, 1, {
        'a.gd':
          'preload("res://packages/11/b.gd") preload("res://packages/5/x.gd")',
      });
      await writePublished(11, 1, {
        'b.gd': 'preload("res://packages/10/a.gd")',
      });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 10, roomId: 7, revision: 1 },
        { packageId: 11, roomId: 7, revision: 1 },
      ]);
    });

    it('skips an undecodable package but still returns the good dependents', async () => {
      definePackage(5, 'Library', null);
      definePackage(10, 'Good', 7);
      definePackage(20, 'Broken', 7);
      await writePublished(10, 1, {
        'a.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(20, 1, { 'bad.gd': Buffer.from([0xff, 0xfe]) });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      const warn = jest
        .spyOn(internals().logger, 'warn')
        .mockImplementation(() => undefined);

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 10, roomId: 7, revision: 1 },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping package 20'),
      );
      warn.mockRestore();
    });

    it('finds a dependent that references the package by slug', async () => {
      definePackage(5, 'Library', null, 'library');
      definePackage(10, 'Game', 7, 'game');
      await writePublished(10, 1, {
        'a.gd': 'preload("res://packages/library/x.gd")',
      });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 10, roomId: 7, revision: 1 },
      ]);
    });

    it('skips and logs an edge that references an unknown slug', async () => {
      definePackage(5, 'Library', null, 'library');
      definePackage(20, 'Broken', 7, 'broken');
      definePackage(10, 'Good', 7, 'good');
      await writePublished(20, 1, {
        'b.gd': 'preload("res://packages/nope/x.gd")',
      });
      await writePublished(10, 1, {
        'a.gd': 'preload("res://packages/library/x.gd")',
      });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      const warn = jest
        .spyOn(internals().logger, 'warn')
        .mockImplementation(() => undefined);

      await expect(resolver.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 10, roomId: 7, revision: 1 },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown package slug "nope"'),
      );
      warn.mockRestore();
    });

    it('walks a wide dependent graph without a quadratic queue', async () => {
      definePackage(5, 'Library', null);
      for (let id = 100; id < 140; id += 1) {
        definePackage(id, `Dependent${id}`, 7);
        await writePublished(id, 1, {
          'a.gd': 'preload("res://packages/5/x.gd")',
        });
      }
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      const dependents = await resolver.findDependentRoomPackages(5);

      expect(dependents).toHaveLength(40);
      expect(dependents[0].packageId).toBe(100);
      expect(dependents[39].packageId).toBe(139);
    });
  });

  describe('byte cache', () => {
    it('bounds the cache and evicts the oldest entries', async () => {
      definePackage(5, 'Heroes', 7);
      await writePublished(5, 3, {
        'a.gd': 'a'.repeat(40),
        'b.gd': 'b'.repeat(40),
        'c.gd': 'c'.repeat(40),
      });

      internals().maxFileCacheBytes = 64;

      await resolver.resolve(5, 3, 7);

      expect(internals().fileCacheBytes).toBeLessThanOrEqual(64);
      expect(internals().fileBytes.size).toBe(1);
      expect(internals().fileBytes.has('5:3:c.gd')).toBe(true);
    });

    it('does not cache a single file larger than the cache cap', async () => {
      definePackage(5, 'Heroes', 7);
      await writePublished(5, 3, { 'big.gd': 'x'.repeat(100) });

      internals().maxFileCacheBytes = 64;

      await resolver.resolve(5, 3, 7);

      expect(internals().fileBytes.size).toBe(0);
    });

    it('re-reads bytes after invalidatePackage', async () => {
      definePackage(5, 'Heroes', 7);
      await writePublished(5, 3, {
        'a.gd': 'extends Node',
        'b.gd': 'extends Node',
      });
      const read = jest.spyOn(storage, 'readPublishedFile');

      await resolver.resolve(5, 3, 7);
      resolver.invalidatePackage(5);
      await resolver.resolve(5, 3, 7);

      expect(read).toHaveBeenCalledTimes(4);
      expect(internals().fileBytes.size).toBe(2);
    });
  });

  describe('resolve', () => {
    it('returns the root files, its bytes and the pinned closure', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      await writePublished(5, 3, {
        'main.gd': 'const Lib = preload("res://packages/6/lib.gd")',
      });
      await writePublished(6, 9, { 'lib.gd': 'extends Node' });

      const resolved = await resolver.resolve(5, 3, 7);

      expect(resolved.revisionByPackage.get(5)).toBe(3);
      expect(resolved.revisionByPackage.get(6)).toBe(9);
      expect(resolved.directDependencyIds).toEqual([6]);
      expect([...resolved.rootFiles.map((file) => file.filepath)]).toEqual([
        'main.gd',
      ]);
      expect(resolved.bytes.get('main.gd')?.toString()).toContain(
        'res://packages/6/lib.gd',
      );
      expect(resolved.artifactKeys.size).toBe(2);
    });

    it('does not read binary dependency files while resolving', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      await writePublished(6, 9, {
        'tex.png': Buffer.from([1, 2, 3]),
        'lib.gd': 'extends Node',
      });
      await writePublished(5, 3, {
        'main.gd': 'preload("res://packages/6/lib.gd")',
      });
      const readSpy = jest.spyOn(storage, 'readPublishedFile');

      const resolved = await resolver.resolve(5, 3, 7);

      expect(readSpy.mock.calls).toEqual([
        [5, 3, 'main.gd'],
        [6, 9, 'lib.gd'],
      ]);
      expect([...resolved.bytes.keys()]).toEqual(['main.gd']);
    });

    it('rejects an unpublished dependency', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      await writePublished(5, 3, {
        'main.gd': 'const Lib = preload("res://packages/6/lib.gd")',
      });

      await expect(resolver.resolve(5, 3, 7)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a missing explicit revision', async () => {
      definePackage(5, 'Heroes', 7);

      await expect(resolver.resolve(5, 4, 7)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('resolves a dependency reference written with a slug', async () => {
      const slugResolver = await makeResolver({
        packages: [
          { id: 7, slug: 'root' },
          { id: 9, slug: 'hero' },
        ],
        published: [7, 9],
        reference: 'res://packages/hero/lib.gd',
      });

      const closure = await slugResolver.resolve(7, 1, 3);

      expect(closure.directDependencyIds).toEqual([9]);
      expect(closure.slugByPackage.get(9)).toBe('hero');
    });

    it('resolves a slug to the room package before the global one', async () => {
      definePackage(1, 'RoomHero', 5, 'hero');
      definePackage(3, 'GlobalHero', null, 'hero');
      await writePublished(1, 1, {
        'main.gd': 'preload("res://packages/hero/lib.gd")',
        'lib.gd': 'extends Node',
      });
      await writePublished(3, 1, { 'lib.gd': 'extends Node' });

      const closure = await resolver.resolve(1, 1, 5);

      expect(closure.revisionByPackage.get(1)).toBe(1);
      expect(closure.revisionByPackage.has(3)).toBe(false);
      expect(closure.directDependencyIds).toEqual([]);
    });

    it('still resolves a legacy numeric reference', async () => {
      const numericResolver = await makeResolver({
        packages: [
          { id: 7, slug: '7' },
          { id: 9, slug: 'hero' },
        ],
        published: [7, 9],
        reference: 'res://packages/9/lib.gd',
      });

      const closure = await numericResolver.resolve(7, 1, 3);

      expect(closure.directDependencyIds).toEqual([9]);
    });

    it('distinguishes an unknown slug from an unpublished package', async () => {
      const unknown = await makeResolver({
        packages: [{ id: 7, slug: 'root' }],
        reference: 'res://packages/missing/lib.gd',
      });
      await expect(unknown.resolve(7, 1, 3)).rejects.toMatchObject({
        response: { code: 'package_dependency_unknown_slug', slug: 'missing' },
      });
    });

    it('keeps package_dependency_unpublished for a known unpublished slug', async () => {
      const unpublished = await makeResolver({
        packages: [
          { id: 7, slug: 'root' },
          { id: 9, slug: 'hero' },
        ],
        published: [7],
        reference: 'res://packages/hero/lib.gd',
      });
      await expect(unpublished.resolve(7, 1, 3)).rejects.toMatchObject({
        response: { code: 'package_dependency_unpublished', packageId: 9 },
      });
    });
  });

  describe('pinned dependencies', () => {
    it('keeps the artifact key stable when a dependency publishes later', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      await writePublished(
        6,
        9,
        { 'lib.gd': 'lib-v9' },
        new Date('2026-10-29T00:00:00.000Z'),
      );
      await writePublished(
        5,
        3,
        { 'main.gd': 'preload("res://packages/6/lib.gd")' },
        new Date('2026-10-30T00:00:00.000Z'),
      );
      await storage.writePinnedDependencies(5, 3, new Map([[6, 9]]));

      const first = await resolver.resolve(5, 3, 7);
      await writePublished(
        6,
        10,
        { 'lib.gd': 'lib-v10' },
        new Date('2026-11-01T00:00:00.000Z'),
      );
      const second = await resolver.resolve(5, 3, 7);

      expect(first.revisionByPackage.get(6)).toBe(9);
      expect(second.revisionByPackage.get(6)).toBe(9);
      expect(second.artifactKeys.get(5)).toBe(first.artifactKeys.get(5));
      expect(second.artifactKeys.get(6)).toBe(first.artifactKeys.get(6));
    });

    it('follows a pin through a transitive dependency', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      definePackage(7, 'Base', null);
      await writePublished(7, 1, { 'base.gd': 'base-v1' });
      await writePublished(6, 9, {
        'lib.gd': 'preload("res://packages/7/base.gd")',
      });
      await writePublished(5, 3, {
        'main.gd': 'preload("res://packages/6/lib.gd")',
      });
      await storage.writePinnedDependencies(6, 9, new Map([[7, 1]]));
      await storage.writePinnedDependencies(5, 3, new Map([[6, 9]]));

      await writePublished(7, 2, { 'base.gd': 'base-v2' });
      const resolved = await resolver.resolve(5, 3, 7);

      expect(resolved.revisionByPackage.get(7)).toBe(1);
    });

    it('falls back to the latest published revision without a pin', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      await writePublished(6, 9, { 'lib.gd': 'lib-v9' });
      await writePublished(5, 3, {
        'main.gd': 'preload("res://packages/6/lib.gd")',
      });
      await writePublished(6, 10, { 'lib.gd': 'lib-v10' });

      const resolved = await resolver.resolve(5, 3, 7);

      expect(resolved.revisionByPackage.get(6)).toBe(10);
    });

    it('rejects a pinned revision that is no longer published', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      await writePublished(6, 9, { 'lib.gd': 'lib-v9' });
      await writePublished(5, 3, {
        'main.gd': 'preload("res://packages/6/lib.gd")',
      });
      revisions.find(
        (row) => row.packageId === 6 && row.revision === 9,
      )!.status = 'discarded';
      await storage.writePinnedDependencies(5, 3, new Map([[6, 9]]));

      await expect(resolver.resolve(5, 3, 7)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('computeArtifactKeys', () => {
    it('gives the same key for the same closure regardless of iteration order', () => {
      const revisionsA = new Map([
        [5, 3],
        [6, 9],
      ]);
      const referencesA = new Map([[5, new Set([6])]]);

      const revisionsB = new Map([
        [6, 9],
        [5, 3],
      ]);
      const referencesB = new Map([[5, new Set([6])]]);

      const keysA = resolver.computeArtifactKeys(revisionsA, referencesA);
      const keysB = resolver.computeArtifactKeys(revisionsB, referencesB);

      expect(keysA.get(5)).toBe(keysB.get(5));
      expect(keysA.get(6)).toBe(keysB.get(6));
      expect(keysA.get(5)).not.toBe(keysA.get(6));
    });

    it('changes the key of every package above a changed dependency', () => {
      const before = resolver.computeArtifactKeys(
        new Map([
          [5, 3],
          [6, 9],
        ]),
        new Map([[5, new Set([6])]]),
      );
      const after = resolver.computeArtifactKeys(
        new Map([
          [5, 3],
          [6, 10],
        ]),
        new Map([[5, new Set([6])]]),
      );

      expect(after.get(5)).not.toBe(before.get(5));
      expect(after.get(6)).not.toBe(before.get(6));
    });
  });
});
