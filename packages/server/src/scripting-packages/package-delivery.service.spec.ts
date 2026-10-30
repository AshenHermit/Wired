import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
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
  let packagesRepository: { findOne: jest.Mock };
  let revisionsRepository: { findOne: jest.Mock; find: jest.Mock };
  let readUrls: { createToken: jest.Mock };
  let service: PackageDeliveryService;

  let packages: PackageFixture[];
  let revisions: RevisionFixture[];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wired-delivery-'));
    storage = new PackageStorageService({
      storage: { packagesFilesDir: root, dir: root },
    } as unknown as AppConfigService);

    packages = [];
    revisions = [];

    packagesRepository = {
      findOne: jest.fn((opts: { where: { id: number } }) => {
        return packages.find((pkg) => pkg.id === opts.where.id) ?? null;
      }),
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

  async function artifactDir(
    packageId: number,
    revision: number,
    roomId: number,
  ): Promise<string> {
    const base = path.join(
      root,
      String(packageId),
      'runtime',
      String(roomId),
      String(revision),
    );
    const [depsHash] = await readdir(base);
    return path.join(base, depsHash);
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
    expect(manifest.dependencies).toEqual([
      { packageId: 6, revision: 9, name: 'Library' },
    ]);
    expect(manifest.files.map((f) => f.filepath)).toEqual([
      'hero.gd',
      'main.tscn',
    ]);
    expect(await readArtifact(5, 3, 7, 'main.tscn')).toContain(
      'path="user://wired/rooms/7/packages/5/3/hero.gd"',
    );
    expect(await readArtifact(5, 3, 7, 'main.tscn')).toContain(
      'path="user://wired/rooms/7/packages/6/9/tex.png"',
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

  it('bounds the byte cache and evicts the oldest entries', async () => {
    definePackage(5, 'Heroes', 7);
    await writePublished(5, 3, {
      'a.gd': 'a'.repeat(40),
      'b.gd': 'b'.repeat(40),
      'c.gd': 'c'.repeat(40),
    });

    const internals = service as unknown as {
      maxFileCacheBytes: number;
      fileBytes: Map<string, Buffer>;
      fileCacheBytes: number;
    };
    internals.maxFileCacheBytes = 64;

    await service.getRuntimeManifest(5, 3, 7);

    expect(internals.fileCacheBytes).toBeLessThanOrEqual(64);
    expect(internals.fileBytes.size).toBe(1);
    expect(internals.fileBytes.has('5:3:c.gd')).toBe(true);
  });

  it('does not cache a single file larger than the cache cap', async () => {
    definePackage(5, 'Heroes', 7);
    await writePublished(5, 3, { 'big.gd': 'x'.repeat(100) });

    const internals = service as unknown as {
      maxFileCacheBytes: number;
      fileBytes: Map<string, Buffer>;
    };
    internals.maxFileCacheBytes = 64;

    await service.getRuntimeManifest(5, 3, 7);

    expect(internals.fileBytes.size).toBe(0);
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
      const resolved = await service.resolveRuntimeFile(5, 3, 7, 'hero.gd');

      expect(resolved.size).toBe(Buffer.from('extends Node').byteLength);
      expect(resolved.path).toBe(
        path.join(await artifactDir(5, 3, 7), 'hero.gd'),
      );
    });

    it('rejects a path that is not part of the artifact', async () => {
      await writePublished(5, 3, { 'hero.gd': 'extends Node' });

      await expect(
        service.resolveRuntimeFile(5, 3, 7, '../x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

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

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 10, roomId: 7, revision: 1 },
        { packageId: 11, roomId: 7, revision: 1 },
      ]);
    });

    it('queries published revisions with the expected repository options', async () => {
      definePackage(5, 'Library', null);
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await service.findDependentRoomPackages(5);

      expect(revisionsRepository.find).toHaveBeenCalledWith({
        where: { status: 'published' },
        relations: ['package', 'package.room'],
        order: { revision: 'DESC' },
      });
    });

    it('only considers the latest published revision of a dependent', async () => {
      definePackage(5, 'Library', null);
      definePackage(10, 'A', 7);
      await writePublished(10, 1, {
        'a.gd': 'preload("res://packages/5/x.gd")',
      });
      await writePublished(10, 2, { 'a.gd': 'extends Node' });
      await writePublished(5, 2, { 'x.gd': 'extends Node' });

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([]);
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

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([]);
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

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([
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

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([
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

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([]);
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

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([
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

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([
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

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([
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

      const logger = (service as unknown as { logger: Logger }).logger;
      const warn = jest
        .spyOn(logger, 'warn')
        .mockImplementation(() => undefined);

      await expect(service.findDependentRoomPackages(5)).resolves.toEqual([
        { packageId: 10, roomId: 7, revision: 1 },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping package 20'),
      );
      warn.mockRestore();
    });
  });
});
