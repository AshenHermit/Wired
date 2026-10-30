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
  let packagesRepository: { findOne: jest.Mock };
  let revisionsRepository: { findOne: jest.Mock };
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

  it('rejects a reference path containing traversal segments', async () => {
    definePackage(5, 'Heroes', 7);
    await writePublished(5, 3, {
      'main.gd': 'const X = preload("res://packages/5/../6/x.gd")',
    });

    await expect(service.getRuntimeManifest(5, 3, 7)).rejects.toThrow(
      'package_dependency_invalid_path:../6/x.gd',
    );
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
});
