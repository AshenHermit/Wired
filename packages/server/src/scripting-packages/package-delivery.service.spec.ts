import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PackageFileEntry } from '@wired-io/shared';
import { mkdtempSync, rmSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { AppConfigService } from 'src/config/config.service';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { sha256Hex } from './package-hash';
import { PackageDeliveryService } from './package-delivery.service';
import { PackageReadUrlService } from './package-read-url.service';
import { PackageStorageService } from './package-storage.service';

type PackageFixture = {
  id: number;
  name: string;
  room: { id: number } | null;
};

type RevisionFixture = {
  packageId: number;
  revision: number;
  status: 'draft' | 'published' | 'discarded';
  files: PackageFileEntry[];
  publishedAt: Date | null;
};

describe('PackageDeliveryService', () => {
  let root: string;
  let storage: PackageStorageService;
  let packagesRepository: { findOne: jest.Mock; find: jest.Mock };
  let revisionsRepository: { findOne: jest.Mock; find: jest.Mock };
  let roomsRepository: { exist: jest.Mock };
  let readUrls: { createToken: jest.Mock };
  let service: PackageDeliveryService;

  let packages: PackageFixture[];
  let revisions: RevisionFixture[];
  let rooms: Set<number>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wired-delivery-'));
    storage = new PackageStorageService({
      storage: { packagesFilesDir: root, dir: root },
    } as unknown as AppConfigService);

    packages = [];
    revisions = [];
    rooms = new Set([7, 8]);

    packagesRepository = {
      findOne: jest.fn((opts: { where: { id: number } }) => {
        return packages.find((pkg) => pkg.id === opts.where.id) ?? null;
      }),
      find: jest.fn((opts: { where: { room?: { id: number } } }) =>
        packages.filter(
          (pkg) =>
            opts.where.room === undefined ||
            pkg.room?.id === opts.where.room.id,
        ),
      ),
    };
    roomsRepository = {
      exist: jest.fn((opts: { where: { id: number } }) =>
        Promise.resolve(rooms.has(opts.where.id)),
      ),
    };
    revisionsRepository = {
      find: jest.fn((opts: { where: { status?: string } }) => {
        const status = opts.where.status;
        return revisions
          .filter((row) => status === undefined || row.status === status)
          .sort((a, b) => b.revision - a.revision)
          .map((row) => toRevisionRow(row, packageById(row.packageId)));
      }),
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
    readUrls = {
      createToken: jest.fn(() => ({
        token: 'signed-token',
        expiresAt: 999999,
      })),
    };

    service = new PackageDeliveryService(
      packagesRepository as never,
      revisionsRepository as never,
      roomsRepository as never,
      storage,
      readUrls as unknown as PackageReadUrlService,
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
  ): void {
    packages.push({ id, name, room: roomId === null ? null : { id: roomId } });
  }

  async function writePublished(
    packageId: number,
    revision: number,
    files: Record<string, string | Buffer>,
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
      publishedAt: new Date('2026-10-30T00:00:00.000Z'),
    });
  }

  async function artifactDirs(
    packageId: number,
    revision: number,
    roomId: number,
  ): Promise<string[]> {
    const base = path.join(
      root,
      String(packageId),
      'runtime',
      'v1',
      String(roomId),
      String(revision),
    );
    const names = await readdir(base);
    return names.sort().map((name) => path.join(base, name));
  }

  async function artifactDir(
    packageId: number,
    revision: number,
    roomId: number,
  ): Promise<string> {
    const dirs = await artifactDirs(packageId, revision, roomId);
    expect(dirs).toHaveLength(1);
    return dirs[0];
  }

  async function readArtifact(
    packageId: number,
    revision: number,
    roomId: number,
    filepath: string,
  ): Promise<string> {
    const dir = await artifactDir(packageId, revision, roomId);
    return readFile(path.join(dir, filepath), 'utf8');
  }

  async function readArtifactBytes(
    packageId: number,
    revision: number,
    roomId: number,
    filepath: string,
  ): Promise<Buffer> {
    const dir = await artifactDir(packageId, revision, roomId);
    return readFile(path.join(dir, filepath));
  }

  it('rewrites package paths, strips ext_resource uid and pins dependency revisions', async () => {
    definePackage(5, 'Heroes', 7);
    definePackage(6, 'Library', null);
    await writePublished(5, 3, {
      'main.tscn':
        '[gd_scene format=3]\n' +
        '[ext_resource type="Script" uid="uid://x" path="res://packages/5/hero.gd" id="1"]\n' +
        '[ext_resource type="Texture2D" path="res://packages/6/tex.png" id="2"]\n',
      'hero.gd': 'extends Node',
    });
    await writePublished(6, 9, { 'tex.png': Buffer.from([137, 80, 78, 71]) });

    const manifest = await service.getRuntimeManifest(5, 3, 7);

    expect(manifest.roomId).toBe(7);
    expect(manifest.artifactKey).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.dependencies).toEqual([
      {
        packageId: 6,
        revision: 9,
        name: 'Library',
        artifactKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(manifest.files.map((f) => f.filepath)).toEqual([
      'hero.gd',
      'main.tscn',
    ]);
    const dependencyKey = manifest.dependencies[0].artifactKey;
    expect(await readArtifact(5, 3, 7, 'main.tscn')).toContain(
      `path="user://wired/rooms/7/packages/5/3-${manifest.artifactKey}/hero.gd"`,
    );
    expect(await readArtifact(5, 3, 7, 'main.tscn')).toContain(
      `path="user://wired/rooms/7/packages/6/9-${dependencyKey}/tex.png"`,
    );
    expect(await readArtifact(5, 3, 7, 'main.tscn')).not.toContain(
      'uid="uid://x"',
    );
    expect(manifest.download.token).toBeTruthy();
  });

  it('serves the cached artifact on a repeated call without re-reading sources', async () => {
    definePackage(5, 'Heroes', 7);
    await writePublished(5, 3, { 'hero.gd': 'extends Node' });

    const first = await service.getRuntimeManifest(5, 3, 7);

    const readSpy = jest.spyOn(storage, 'readPublishedFile');
    const second = await service.getRuntimeManifest(5, 3, 7);

    expect(second).toEqual(first);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('rejects a dependency from another room', async () => {
    definePackage(5, 'Heroes', 7);
    definePackage(6, 'Library', 8);
    await writePublished(5, 3, {
      'main.gd': 'const Lib = preload("res://packages/6/lib.gd")',
    });
    await writePublished(6, 9, { 'lib.gd': 'extends Node' });

    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toThrow(
      'package_dependency_room_mismatch:6',
    );
    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an unpublished dependency', async () => {
    definePackage(5, 'Heroes', 7);
    definePackage(6, 'Library', null);
    await writePublished(5, 3, {
      'main.gd': 'const Lib = preload("res://packages/6/lib.gd")',
    });

    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toThrow(
      'package_dependency_unpublished:6',
    );
  });

  it('rejects a dependency whose referenced file is missing', async () => {
    definePackage(5, 'Heroes', 7);
    definePackage(6, 'Library', null);
    await writePublished(5, 3, {
      'main.gd': 'const Tex = preload("res://packages/6/tex.png")',
    });
    await writePublished(6, 9, { 'other.gd': 'extends Node' });

    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toThrow(
      'package_dependency_missing_file:6:tex.png',
    );
  });

  it('rejects a same-package reference to a missing file', async () => {
    definePackage(5, 'Heroes', 7);
    await writePublished(5, 3, {
      'main.tscn':
        '[ext_resource type="Script" path="res://packages/5/missing.gd" id="1"]\n',
    });

    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toThrow(
      'package_dependency_missing_file:5:missing.gd',
    );
  });

  it('rejects a dependency cycle with the stack in the message', async () => {
    definePackage(5, 'Heroes', 7);
    definePackage(6, 'Library', null);
    await writePublished(5, 3, {
      'a.gd': 'const B = preload("res://packages/6/b.gd")',
    });
    await writePublished(6, 9, {
      'b.gd': 'const A = preload("res://packages/5/a.gd")',
    });

    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toThrow(
      'package_dependency_cycle:5->6->5',
    );
  });

  it.each([
    ['res://packages/5/./hero.gd', 'package_reference_invalid_path:./hero.gd'],
    ['res://packages/5/a/../b.gd', 'package_reference_invalid_path:a/../b.gd'],
    ['res://packages/5/../6/x', 'package_reference_invalid_path:../6/x'],
    ['res://packages/5/a\\b.gd', 'package_reference_invalid_path:a\\b.gd'],
  ])('rejects the unsafe reference path %s', async (reference, expected) => {
    definePackage(5, 'Heroes', 7);
    await writePublished(5, 3, {
      'main.gd': `const X = preload("${reference}")`,
    });

    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toThrow(expected);
    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects invalid UTF-8 in a text file during the build', async () => {
    definePackage(5, 'Heroes', 7);
    await writePublished(5, 3, { 'bad.gd': Buffer.from([0xff, 0xfe]) });

    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toThrow(
      'package_text_not_utf8:bad.gd',
    );
    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('copies binary files byte-for-byte with the original hash', async () => {
    definePackage(5, 'Heroes', 7);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writePublished(5, 3, { 'tex.png': png, 'hero.gd': 'extends Node' });

    const manifest = await service.getRuntimeManifest(5, 3, 7);

    const entry = manifest.files.find((f) => f.filepath === 'tex.png');
    expect(entry).toBeDefined();
    expect(entry!.size).toBe(png.byteLength);
    expect(entry!.sha256).toBe(sha256Hex(png));
    expect(await readArtifactBytes(5, 3, 7, 'tex.png')).toEqual(png);
  });

  describe('resolveRuntimeFile', () => {
    beforeEach(() => {
      definePackage(5, 'Heroes', 7);
    });

    it('resolves a file that is part of the artifact', async () => {
      await writePublished(5, 3, { 'hero.gd': 'extends Node' });
      const manifest = await service.getRuntimeManifest(5, 3, 7);
      const resolved = await service.resolveRuntimeFile(
        5,
        3,
        7,
        manifest.artifactKey,
        'hero.gd',
      );

      expect(resolved.size).toBe(Buffer.from('extends Node').byteLength);
      expect(resolved.path).toBe(
        path.join(await artifactDir(5, 3, 7), 'hero.gd'),
      );
    });

    it('rejects a path that is not part of the artifact', async () => {
      await writePublished(5, 3, { 'hero.gd': 'extends Node' });
      const manifest = await service.getRuntimeManifest(5, 3, 7);

      await expect(
        service.resolveRuntimeFile(5, 3, 7, manifest.artifactKey, '../x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a file request for an artifact that no longer exists', async () => {
      await writePublished(5, 3, { 'hero.gd': 'extends Node' });
      const manifest = await service.getRuntimeManifest(5, 3, 7);

      await expect(
        service.resolveRuntimeFile(5, 3, 7, 'f'.repeat(64), 'hero.gd'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a malformed artifact key without touching the disk', async () => {
      await writePublished(5, 3, { 'hero.gd': 'extends Node' });
      await service.getRuntimeManifest(5, 3, 7);

      await expect(
        service.resolveRuntimeFile(5, 3, 7, '../5/3', 'hero.gd'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('room validation', () => {
    beforeEach(() => {
      definePackage(5, 'Heroes', 7);
    });

    it.each([0, -1])(
      'rejects the non-positive room id %d before reading a package',
      async (roomId) => {
        await expect(
          service.getRuntimeManifest(5, 3, roomId),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.resolveRuntimeFile(5, 3, roomId, 'a'.repeat(64), 'hero.gd'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(packagesRepository.findOne).not.toHaveBeenCalled();
      },
    );

    it('rejects a room that does not exist before building an artifact', async () => {
      await writePublished(5, 3, { 'hero.gd': 'extends Node' });

      await expect(service.getRuntimeManifest(5, 3, 99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        service.resolveRuntimeFile(5, 3, 99, 'a'.repeat(64), 'hero.gd'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(artifactDirs(5, 3, 99)).rejects.toThrow();
      expect(packagesRepository.findOne).not.toHaveBeenCalled();
    });

    it('validates the room for a global library request too', async () => {
      definePackage(6, 'Library', null);
      await writePublished(6, 9, { 'lib.gd': 'extends Node' });

      await expect(
        service.getRuntimeManifest(6, 9, 12345),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('artifact identity and cache', () => {
    it('rebuilds a dependent artifact when an unpinned dependency publishes', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      await writePublished(6, 9, { 'lib.gd': 'lib-v9' });
      await writePublished(5, 3, {
        'main.gd': 'const Lib = preload("res://packages/6/lib.gd")',
      });

      const first = await service.getRuntimeManifest(5, 3, 7);
      expect(first.dependencies[0]).toMatchObject({
        packageId: 6,
        revision: 9,
      });

      await writePublished(6, 10, { 'lib.gd': 'lib-v10' });
      const second = await service.getRuntimeManifest(5, 3, 7);

      // The root revision did not change, but the artifact identity must.
      expect(second.revision).toBe(3);
      expect(second.artifactKey).not.toBe(first.artifactKey);
      expect(second.dependencies[0]).toMatchObject({
        packageId: 6,
        revision: 10,
      });
      expect(second.dependencies[0].artifactKey).not.toBe(
        first.dependencies[0].artifactKey,
      );

      const secondDir = path.join(
        root,
        '5',
        'runtime',
        'v1',
        '7',
        '3',
        second.artifactKey,
      );
      const rewritten = await readFile(path.join(secondDir, 'main.gd'), 'utf8');
      expect(rewritten).toContain(
        `user://wired/rooms/7/packages/6/10-${second.dependencies[0].artifactKey}/lib.gd`,
      );
      expect(rewritten).not.toContain(
        `user://wired/rooms/7/packages/6/9-${first.dependencies[0].artifactKey}/lib.gd`,
      );

      // The pinned manifest resolves only the new artifact directory.
      const resolved = await service.resolveRuntimeFile(
        5,
        3,
        7,
        second.artifactKey,
        'main.gd',
      );
      expect(resolved.path).toBe(path.join(secondDir, 'main.gd'));
    });

    it('keeps one (package, revision) artifact when a pinned dependency publishes', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      await writePublished(6, 9, { 'lib.gd': 'lib-v9' });
      await writePublished(5, 3, {
        'main.gd': 'const Lib = preload("res://packages/6/lib.gd")',
      });
      await storage.writePinnedDependencies(5, 3, new Map([[6, 9]]));

      const first = await service.getRuntimeManifest(5, 3, 7);

      await writePublished(6, 10, { 'lib.gd': 'lib-v10' });
      const second = await service.getRuntimeManifest(5, 3, 7);

      expect(second.artifactKey).toBe(first.artifactKey);
      expect(second.dependencies[0]).toMatchObject({
        packageId: 6,
        revision: 9,
      });
      expect(await artifactDirs(5, 3, 7)).toHaveLength(1);
    });

    it('shares one build between concurrent requests', async () => {
      definePackage(5, 'Heroes', 7);
      await writePublished(5, 3, { 'hero.gd': 'extends Node' });
      const buildSpy = jest.spyOn(
        service as unknown as {
          buildArtifact: (
            packageId: number,
            revision: number,
            roomId: number,
          ) => Promise<unknown>;
        },
        'buildArtifact',
      );

      const [first, second] = await Promise.all([
        service.getRuntimeManifest(5, 3, 7),
        service.getRuntimeManifest(5, 3, 7),
      ]);

      expect(second).toEqual(first);
      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(await artifactDirs(5, 3, 7)).toHaveLength(1);
    });

    it('keeps a bounded number of artifacts per package, room and revision', async () => {
      definePackage(5, 'Heroes', 7);
      definePackage(6, 'Library', null);
      await writePublished(5, 3, {
        'main.gd': 'const Lib = preload("res://packages/6/lib.gd")',
      });

      const keys: string[] = [];
      for (let revision = 1; revision <= 5; revision += 1) {
        await writePublished(6, revision, { 'lib.gd': `lib-${revision}` });
        const manifest = await service.getRuntimeManifest(5, 3, 7);
        keys.push(manifest.artifactKey);
      }

      const dirs = await artifactDirs(5, 3, 7);
      expect(dirs).toHaveLength(3);
      expect(dirs).toContain(
        path.join(root, '5', 'runtime', 'v1', '7', '3', keys[4]),
      );
      expect(dirs).not.toContain(
        path.join(root, '5', 'runtime', 'v1', '7', '3', keys[0]),
      );
    });
  });

  describe('collectRuntimePackageIds', () => {
    it('includes the transitive published dependency closure', async () => {
      definePackage(42, 'Root', 7);
      definePackage(10, 'Library', null);
      await writePublished(42, 2, { 'root.gd': 'extends Node' });
      await writePublished(10, 3, { 'lib.gd': 'extends Node' });
      await storage.writePinnedDependencies(42, 2, new Map([[10, 3]]));
      await storage.writePinnedDependencies(10, 3, new Map());

      await expect(service.collectRuntimePackageIds(7)).resolves.toEqual([
        10, 42,
      ]);
    });

    it('does not keep a dependency whose package was deleted', async () => {
      definePackage(42, 'Root', 7);
      await writePublished(42, 2, { 'root.gd': 'extends Node' });
      await storage.writePinnedDependencies(42, 2, new Map([[99, 1]]));

      await expect(service.collectRuntimePackageIds(7)).resolves.toEqual([42]);
    });
  });
});
