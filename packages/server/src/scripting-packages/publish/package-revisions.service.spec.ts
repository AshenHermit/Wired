import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PackageFileEntry, PackageRevision } from '@wired-io/shared';
import { DataSource } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { sha256Hex } from '../storage/package-hash';
import { PackageRevisionsService } from './package-revisions.service';
import { PackagePublishLockService } from './package-publish-lock.service';
import { PackageStorageService } from '../storage/package-storage.service';
import { ScriptingPackagesService } from '../scripting-packages.service';
import type { PackageRevisionDispatcher } from 'src/common/runtime-contracts';

/**
 * A publish lock that never blocks. The service refuses to run without one, so
 * every construction in this file has to pass something even when the test is
 * not about locking.
 */
const stubPublishLocks = () =>
  ({
    assertNotPublishing: jest.fn(async () => undefined),
    runWithPublishLocks: jest.fn(
      async (_packageIds: number[], run: () => Promise<unknown>) => run(),
    ),
  }) as unknown as PackagePublishLockService;

const pkg = {
  id: 7,
  name: 'Heroes',
  slug: 'hero',
} as ScriptingPackage;

const file = (filepath: string, text: string): PackageFileEntry => {
  const data = Buffer.from(text);
  return { filepath, size: data.byteLength, sha256: sha256Hex(data) };
};

const draftRow = (
  revision: number,
  files: PackageFileEntry[],
): ScriptingPackageRevision =>
  ({
    id: revision * 10,
    package: pkg,
    revision,
    status: 'draft',
    files,
    createdAt: new Date('2026-10-29T10:00:00.000Z'),
    publishedAt: null,
  }) as ScriptingPackageRevision;

const publishedRow = (
  revision: number,
  files: PackageFileEntry[],
): ScriptingPackageRevision => ({
  ...draftRow(revision, files),
  status: 'published',
  publishedAt: new Date('2026-10-29T11:00:00.000Z'),
});

const entry = (filepath: string, data: Buffer): PackageFileEntry => ({
  filepath,
  size: data.byteLength,
  sha256: sha256Hex(data),
});

describe('PackageRevisionsService', () => {
  let repository: {
    maximum: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let packagesService: { findOne: jest.Mock };
  let packagesRepository: { find: jest.Mock };
  let storage: {
    saveDraftFile: jest.Mock;
    publishRevision: jest.Mock;
    discardDraft: jest.Mock;
    readPublishedFile: jest.Mock;
    readPublishedFiles: jest.Mock;
    readPublishedTextFiles: jest.Mock;
    readDraftFile: jest.Mock;
    resolvePublishedFile: jest.Mock;
    writePinnedDependencies: jest.Mock;
    readPinnedDependencies: jest.Mock;
    missingFiles: jest.Mock;
    migratePackage: jest.Mock;
    cleanupLegacyRevisions: jest.Mock;
  };
  let service: PackageRevisionsService;
  let dispatcher: { revisionPublished: jest.Mock };

  beforeEach(() => {
    repository = {
      maximum: jest.fn(async () => 0),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({
        ...value,
        id: 1,
        createdAt: value.createdAt ?? new Date('2026-10-29T10:00:00.000Z'),
      })),
      findOne: jest.fn(async () => null),
      find: jest.fn(async () => []),
      delete: jest.fn(async () => ({ affected: 1 })),
      manager: {
        transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) =>
          fn({ update: jest.fn(async () => undefined) }),
        ),
      },
    };
    packagesService = { findOne: jest.fn(async () => pkg) };
    packagesRepository = { find: jest.fn(async () => []) };
    dispatcher = { revisionPublished: jest.fn(async () => undefined) };
    storage = {
      saveDraftFile: jest.fn(async (_id, _rev, _path, data: Buffer) => ({
        size: data.byteLength,
        sha256: sha256Hex(data),
      })),
      publishRevision: jest.fn(async (_id, _rev, _files, commit) => commit()),
      missingFiles: jest.fn(async () => []),
      discardDraft: jest.fn(async () => undefined),
      readPublishedFile: jest.fn(async () => Buffer.from('x')),
      readPublishedFiles: jest.fn(async () => new Map()),
      readPublishedTextFiles: jest.fn(async () => new Map()),
      readDraftFile: jest.fn(async () => ''),
      resolvePublishedFile: jest.fn(async () => ({
        path: '/tmp/a.txt',
        size: 1,
      })),
      writePinnedDependencies: jest.fn(async () => undefined),
      readPinnedDependencies: jest.fn(async () => null),
      migratePackage: jest.fn(async () => new Map<number, string>()),
      cleanupLegacyRevisions: jest.fn(async () => 0),
    };
    service = new PackageRevisionsService(
      repository as never,
      packagesService as unknown as ScriptingPackagesService,
      storage as unknown as PackageStorageService,
      new PackagePublishLockService(),
      dispatcher as unknown as PackageRevisionDispatcher,
      packagesRepository as never,
      {
        reconcilePackage: jest.fn(async () => undefined),
        reconcilePackageLocked: jest.fn(async () => undefined),
      } as never,
    );
  });

  describe('createDraft', () => {
    it('rejects an empty file list', async () => {
      await expect(service.createDraft(7, { files: [] })).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rejects a file entry with an invalid hash', async () => {
      await expect(
        service.createDraft(7, {
          files: [{ filepath: 'a.txt', size: 1, sha256: 'not-a-hash' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a concurrent draft instead of leaking a unique violation', async () => {
      repository.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );

      await expect(
        service.createDraft(7, { files: [file('a.txt', 'a')] }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to create a draft while the package is being published', async () => {
      repository.findOne.mockResolvedValue(draftRow(1, [file('a.txt', 'a')]));
      let publishStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        publishStarted = resolve;
      });
      storage.publishRevision.mockImplementation(async () => {
        publishStarted();
        await new Promise(() => undefined);
      });

      void service.publish(7, 1);
      await started;

      await expect(
        service.createDraft(7, { files: [file('b.txt', 'b')] }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('stores a draft with the next revision number', async () => {
      repository.maximum.mockResolvedValue(4);

      const revision = await service.createDraft(7, {
        files: [file('a.txt', 'a')],
      });

      expect(revision.revision).toBe(5);
      expect(revision.status).toBe('draft');
      expect(revision.packageId).toBe(7);
      expect(revision.publishedAt).toBeNull();
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 5, status: 'draft' }),
      );
    });

    it('reports files the package git repository does not have yet', async () => {
      repository.maximum.mockResolvedValue(4);
      storage.missingFiles.mockResolvedValueOnce(['b.txt']);

      const revision = await service.createDraft(7, {
        files: [file('a.txt', 'a'), file('b.txt', 'b')],
      });

      expect(storage.missingFiles).toHaveBeenCalledWith(7, revision.files);
      expect(revision.missing).toEqual(['b.txt']);
    });

    it('supersedes unfinished drafts of the same package', async () => {
      repository.find.mockResolvedValue([draftRow(1, []), draftRow(2, [])]);

      await service.createDraft(7, { files: [file('a.txt', 'a')] });

      expect(repository.delete).not.toHaveBeenCalled();
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 1, status: 'discarded' }),
      );
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 2, status: 'discarded' }),
      );
      expect(storage.discardDraft).toHaveBeenCalledWith(7, 1);
      expect(storage.discardDraft).toHaveBeenCalledWith(7, 2);
    });

    it('reports a missing package', async () => {
      packagesService.findOne.mockRejectedValue(
        new NotFoundException('no pkg'),
      );

      await expect(
        service.createDraft(99, { files: [file('a.txt', 'a')] }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('uploadFile', () => {
    it('writes only files declared in the draft', async () => {
      repository.findOne.mockResolvedValue(draftRow(2, [file('a.txt', 'a')]));

      await service.uploadFile(7, 2, 'a.txt', Buffer.from('a'));

      expect(storage.saveDraftFile).toHaveBeenCalledWith(
        7,
        2,
        'a.txt',
        Buffer.from('a'),
      );
    });

    it('refuses files that are not part of the manifest', async () => {
      repository.findOne.mockResolvedValue(draftRow(2, [file('a.txt', 'a')]));

      await expect(
        service.uploadFile(7, 2, 'b.txt', Buffer.from('b')),
      ).rejects.toThrow(BadRequestException);
      expect(storage.saveDraftFile).not.toHaveBeenCalled();
    });

    it('refuses to modify a published revision', async () => {
      repository.findOne.mockResolvedValue({
        ...draftRow(2, [file('a.txt', 'a')]),
        status: 'published',
      });

      await expect(
        service.uploadFile(7, 2, 'a.txt', Buffer.from('a')),
      ).rejects.toThrow(ConflictException);
    });

    it('reports an unknown revision', async () => {
      await expect(
        service.uploadFile(7, 2, 'a.txt', Buffer.from('a')),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('publish', () => {
    it('verifies files on disk and marks the revision published', async () => {
      const declared = [file('a.txt', 'a')];
      const row = draftRow(3, declared);
      repository.findOne.mockResolvedValue(row);
      repository.save.mockImplementation(async (value) => value);

      const published = await service.publish(7, 3);

      expect(storage.publishRevision).toHaveBeenCalledWith(
        7,
        3,
        declared,
        expect.any(Function),
        expect.objectContaining({
          name: expect.any(String),
          email: expect.any(String),
        }),
      );
      expect(published.status).toBe('published');
      expect(published.publishedAt).toEqual(expect.any(String));
      expect(dispatcher.revisionPublished).toHaveBeenCalledWith(7, 3);
    });

    it('stores the commit sha returned by the storage layer', async () => {
      const declared = [file('a.txt', 'a')];
      const row = draftRow(3, declared);
      repository.findOne.mockResolvedValue(row);
      repository.save.mockImplementation(async (value) => value);
      storage.publishRevision.mockImplementationOnce(
        async (
          _id: number,
          _rev: number,
          _files: unknown,
          commit: (sha: string | null) => Promise<void>,
        ) => commit('abc123'),
      );

      await service.publish(7, 3);

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'published',
          commitSha: 'abc123',
        }),
      );
    });

    it('records the dependency revisions resolved at publish time', async () => {
      const row = draftRow(3, [
        file('main.gd', 'preload("res://packages/6/lib.gd")'),
      ]);
      repository.findOne.mockImplementation(
        async (opts: {
          where: {
            package: { id: number };
            revision?: number;
            status?: string;
          };
        }) => {
          if (opts.where.package.id === 7) {
            return row;
          }
          if (
            opts.where.package.id === 6 &&
            opts.where.status === 'published'
          ) {
            return { revision: 9 };
          }
          return null;
        },
      );
      storage.readPublishedTextFiles.mockResolvedValue(
        new Map([['main.gd', 'preload("res://packages/6/lib.gd")']]),
      );

      await service.publish(7, 3);

      expect(storage.writePinnedDependencies).toHaveBeenCalledWith(
        7,
        3,
        new Map([[6, 9]]),
      );
    });

    it('records a dependency pinned through a slug reference', async () => {
      const row = draftRow(3, [
        file('main.gd', 'preload("res://packages/library/lib.gd")'),
      ]);
      repository.findOne.mockImplementation(
        async (opts: {
          where: {
            package: { id: number };
            revision?: number;
            status?: string;
          };
        }) => {
          if (opts.where.package.id === 7) {
            return row;
          }
          if (
            opts.where.package.id === 6 &&
            opts.where.status === 'published'
          ) {
            return { revision: 9 };
          }
          return null;
        },
      );
      storage.readPublishedTextFiles.mockResolvedValue(
        new Map([['main.gd', 'preload("res://packages/library/lib.gd")']]),
      );
      packagesRepository.find.mockImplementation(
        async (opts?: { select?: unknown }) =>
          opts?.select ? [{ id: 6, slug: 'library' }] : [],
      );

      await service.publish(7, 3);

      expect(storage.writePinnedDependencies).toHaveBeenCalledWith(
        7,
        3,
        new Map([[6, 9]]),
      );
    });

    it('rejects publishing a reference to an unknown slug', async () => {
      const row = draftRow(3, [
        file('main.gd', 'preload("res://packages/missing/x.tscn")'),
      ]);
      repository.findOne.mockResolvedValue(row);
      storage.readDraftFile.mockResolvedValue(
        'preload("res://packages/missing/x.tscn")',
      );

      await expect(service.publish(7, 3)).rejects.toMatchObject({
        response: { code: 'package_dependency_unknown_slug', slug: 'missing' },
      });
      expect(storage.publishRevision).not.toHaveBeenCalled();
    });

    it('rejects publishing when a slug dependency is disabled', async () => {
      const row = draftRow(3, [
        file('main.gd', 'preload("res://packages/off/a.tscn")'),
      ]);
      repository.findOne.mockImplementation(
        async (opts: { where: { status?: string } }) =>
          opts.where.status === 'published' ? null : row,
      );
      storage.readDraftFile.mockResolvedValue(
        'preload("res://packages/off/a.tscn")',
      );
      packagesService.findOne.mockResolvedValue({ id: 42, room: { id: 7 } });
      packagesRepository.find.mockImplementation(
        async (opts?: { select?: unknown }) =>
          opts?.select
            ? [{ id: 9, slug: 'off' }]
            : [{ id: 9, enabled: false, room: { id: 7 }, name: 'Off' }],
      );

      await expect(service.publish(42, 3)).rejects.toMatchObject({
        response: {
          code: 'dependency_disabled',
          dependencyId: 9,
        },
      });
      expect(storage.publishRevision).not.toHaveBeenCalled();
    });

    it('rejects publishing when a same-room dependency is disabled', async () => {
      const row = draftRow(3, [
        file('main.gd', 'preload("res://packages/9/a.tscn")'),
      ]);
      repository.findOne.mockImplementation(
        async (opts: { where: { status?: string } }) =>
          opts.where.status === 'published' ? null : row,
      );
      storage.readDraftFile.mockResolvedValue(
        'preload("res://packages/9/a.tscn")',
      );
      packagesService.findOne.mockResolvedValue({ id: 42, room: { id: 7 } });
      packagesRepository.find.mockResolvedValue([
        { id: 9, enabled: false, room: { id: 7 }, name: 'Off' },
      ]);

      await expect(service.publish(42, 3)).rejects.toMatchObject({
        response: {
          code: 'dependency_disabled',
          dependencyId: 9,
          name: 'Off',
        },
      });
      expect(storage.publishRevision).not.toHaveBeenCalled();
    });

    it('keeps the publication even when the pins cannot be recorded', async () => {
      repository.findOne.mockResolvedValue(
        draftRow(3, [file('main.gd', 'preload("res://packages/6/lib.gd")')]),
      );
      storage.readPublishedTextFiles.mockResolvedValue(
        new Map([['main.gd', 'preload("res://packages/6/lib.gd")']]),
      );
      storage.writePinnedDependencies.mockRejectedValue(new Error('disk full'));

      await expect(service.publish(7, 3)).resolves.toMatchObject({
        status: 'published',
      });
    });

    it('returns the fixed revision even when runtime dispatch fails', async () => {
      repository.findOne.mockResolvedValue(draftRow(3, [file('a.txt', 'a')]));
      dispatcher.revisionPublished.mockRejectedValue(
        new Error('runtime unavailable'),
      );

      await expect(service.publish(7, 3)).resolves.toMatchObject({
        status: 'published',
      });
    });

    it('is idempotent for an already published revision', async () => {
      repository.findOne.mockResolvedValue({
        ...draftRow(3, [file('a.txt', 'a')]),
        status: 'published',
        publishedAt: new Date('2026-10-29T11:00:00.000Z'),
      });

      const published = await service.publish(7, 3);

      expect(storage.publishRevision).not.toHaveBeenCalled();
      expect(published.status).toBe('published');
      expect(published.publishedAt).toBe('2026-10-29T11:00:00.000Z');
    });

    it('does not report success when the store rejects the revision', async () => {
      repository.findOne.mockResolvedValue(draftRow(3, [file('a.txt', 'a')]));
      storage.publishRevision.mockRejectedValue(
        new BadRequestException('Cannot publish revision, sha256 mismatch'),
      );

      await expect(service.publish(7, 3)).rejects.toThrow(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('manifest', () => {
    it('reports a package that was never published', async () => {
      await expect(service.getManifest(7)).rejects.toThrow(NotFoundException);
    });

    it('returns the latest published revision with a total size', async () => {
      repository.findOne.mockResolvedValue({
        ...draftRow(3, [file('a.txt', 'aaa'), file('b/c.txt', 'cc')]),
        status: 'published',
        publishedAt: new Date('2026-10-29T11:00:00.000Z'),
      });

      const manifest = await service.getManifest(7);

      expect(repository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { package: { id: 7 }, status: 'published' },
          order: { revision: 'DESC' },
        }),
      );
      expect(manifest).toMatchObject({
        packageId: 7,
        name: 'Heroes',
        slug: 'hero',
        revision: 3,
        totalSize: 5,
        publishedAt: '2026-10-29T11:00:00.000Z',
      });
    });

    it('returns an older published revision with the package slug', async () => {
      repository.findOne.mockResolvedValue({
        ...draftRow(2, [file('a.txt', 'a')]),
        status: 'published',
        publishedAt: new Date('2026-10-29T10:30:00.000Z'),
      });

      const manifest = await service.getManifestForRevision(7, 2);

      expect(manifest.slug).toBe('hero');
      expect(manifest.revision).toBe(2);
    });
  });

  describe('readPublishedFile', () => {
    it('serves only files declared in a published revision', async () => {
      repository.findOne.mockResolvedValue({
        ...draftRow(3, [file('a.txt', 'a')]),
        status: 'published',
      });

      await expect(service.readPublishedFile(7, 3, 'a.txt')).resolves.toEqual(
        Buffer.from('x'),
      );
      await expect(
        service.readPublishedFile(7, 3, 'secret.txt'),
      ).rejects.toThrow(NotFoundException);
      expect(storage.readPublishedFile).toHaveBeenCalledTimes(1);
    });

    it('never serves a draft revision', async () => {
      repository.findOne.mockResolvedValue(draftRow(3, [file('a.txt', 'a')]));

      await expect(service.readPublishedFile(7, 3, 'a.txt')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('resolvePublishedFile', () => {
    it('returns a descriptor for a declared published file', async () => {
      repository.findOne.mockResolvedValue({
        ...draftRow(3, [file('a.txt', 'a')]),
        status: 'published',
      });

      await expect(
        service.resolvePublishedFile(7, 3, 'a.txt'),
      ).resolves.toEqual({ path: '/tmp/a.txt', size: 1 });
      expect(storage.resolvePublishedFile).toHaveBeenCalledWith(
        7,
        3,
        'a.txt',
        undefined,
        1,
      );
    });

    it('rejects files that are not declared in the revision', async () => {
      repository.findOne.mockResolvedValue({
        ...draftRow(3, [file('a.txt', 'a')]),
        status: 'published',
      });

      await expect(
        service.resolvePublishedFile(7, 3, 'secret.txt'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('lists published revisions newest first and hides drafts by default', async () => {
    repository.find.mockResolvedValue([
      draftRow(3, []),
      draftRow(2, []),
      draftRow(1, []),
    ]);

    const revisions = await service.list(7);

    expect(revisions.map((item: PackageRevision) => item.revision)).toEqual([
      3, 2, 1,
    ]);
    expect(repository.find).toHaveBeenCalledWith({
      where: { package: { id: 7 }, status: 'published' },
      order: { revision: 'DESC' },
    });
  });

  it('includes drafts only when the caller asks for them', async () => {
    repository.find.mockResolvedValue([draftRow(2, [])]);

    await service.list(7, { includeDrafts: true });

    expect(repository.find).toHaveBeenCalledWith({
      where: { package: { id: 7 } },
      order: { revision: 'DESC' },
    });
  });

  it('refuses to publish a revision that a newer draft replaced', async () => {
    repository.findOne.mockResolvedValue({
      ...draftRow(3, [file('a.txt', 'a')]),
      status: 'discarded',
    });

    await expect(service.publish(7, 3)).rejects.toThrow(ConflictException);
    expect(storage.publishRevision).not.toHaveBeenCalled();
  });

  it('refuses uploads while the same package is being published', async () => {
    repository.findOne.mockResolvedValue(draftRow(3, [file('a.txt', 'a')]));
    let release: () => void = () => undefined;
    storage.publishRevision.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const publishing = service.publish(7, 3);
    while (storage.publishRevision.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await expect(
      service.uploadFile(7, 3, 'a.txt', Buffer.from('a')),
    ).rejects.toThrow(ConflictException);

    release();
    await publishing;
    await expect(
      service.uploadFile(7, 3, 'a.txt', Buffer.from('a')),
    ).resolves.toBeDefined();
  });

  describe('advisory publish lock', () => {
    let runner: { connect: jest.Mock; query: jest.Mock; release: jest.Mock };
    let dataSource: { createQueryRunner: jest.Mock };

    const lockSql = 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked';
    const unlockSql = 'SELECT pg_advisory_unlock(hashtext($1))';
    const lockKey = 'wired.package-publish:7';

    function makeService() {
      return new PackageRevisionsService(
        repository as never,
        packagesService as unknown as ScriptingPackagesService,
        storage as unknown as PackageStorageService,
        new PackagePublishLockService(dataSource as unknown as DataSource),
        dispatcher as unknown as PackageRevisionDispatcher,
        packagesRepository as never,
        { reconcilePackage: jest.fn(async () => undefined),
          reconcilePackageLocked: jest.fn(async () => undefined) } as never,
      );
    }

    beforeEach(() => {
      runner = {
        connect: jest.fn(async () => undefined),
        query: jest.fn(async () => [{ locked: true }]),
        release: jest.fn(async () => undefined),
      };
      dataSource = { createQueryRunner: jest.fn(() => runner) };
    });

    it('takes and releases a Postgres advisory lock while publishing', async () => {
      repository.findOne.mockResolvedValue(draftRow(3, [file('a.txt', 'a')]));
      const service = makeService();

      await service.publish(7, 3);

      expect(runner.query).toHaveBeenCalledWith(lockSql, [lockKey]);
      expect(runner.query).toHaveBeenCalledWith(unlockSql, [lockKey]);
      expect(runner.release).toHaveBeenCalled();
    });

    it('rejects a publication that another instance already holds', async () => {
      repository.findOne.mockResolvedValue(draftRow(3, [file('a.txt', 'a')]));
      runner.query.mockResolvedValue([{ locked: false }]);
      const service = makeService();

      await expect(service.publish(7, 3)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(storage.publishRevision).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled();
    });

    it('treats a lock held elsewhere as publishing for draft creation', async () => {
      runner.query.mockResolvedValue([{ locked: false }]);
      const service = makeService();

      await expect(
        service.createDraft(7, { files: [file('a.txt', 'a')] }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('treats a lock held elsewhere as publishing for uploads', async () => {
      repository.findOne.mockResolvedValue(draftRow(3, [file('a.txt', 'a')]));
      runner.query.mockResolvedValue([{ locked: false }]);
      const service = makeService();

      await expect(
        service.uploadFile(7, 3, 'a.txt', Buffer.from('a')),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(storage.saveDraftFile).not.toHaveBeenCalled();
    });

    it('releases the probe lock it managed to take', async () => {
      const service = makeService();

      await expect(
        service.createDraft(7, { files: [file('a.txt', 'a')] }),
      ).resolves.toMatchObject({ revision: 1 });
      expect(runner.query).toHaveBeenCalledWith(unlockSql, [lockKey]);
    });

    it('still publishes when the lock cannot be taken because of a DB error', async () => {
      repository.findOne.mockResolvedValue(draftRow(3, [file('a.txt', 'a')]));
      runner.query.mockRejectedValue(new Error('connection reset'));
      const service = makeService();

      await expect(service.publish(7, 3)).resolves.toMatchObject({
        status: 'published',
      });
      expect(storage.publishRevision).toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled();
    });

    it('keeps working without a DataSource', async () => {
      repository.findOne.mockResolvedValue(draftRow(3, [file('a.txt', 'a')]));

      await expect(service.publish(7, 3)).resolves.toMatchObject({
        status: 'published',
      });
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });
  });

  describe('publishCopiedRevision', () => {
    it('converts legacy revisions of the copy target before publishing', async () => {
      const targetPackageId = 12;
      const script = Buffer.from('extends Node\n');
      repository.findOne.mockResolvedValue(publishedRow(4, [entry('a.gd', script)]));
      storage.readPublishedFiles.mockResolvedValue(
        new Map([['a.gd', script]]),
      );
      repository.find.mockResolvedValue([
        {
          id: 77,
          revision: 1,
          status: 'published',
          commitSha: null,
          files: [entry('a.gd', script)],
          publishedAt: new Date('2026-10-29T11:00:00.000Z'),
          createdAt: new Date('2026-10-29T10:00:00.000Z'),
        },
      ]);
      storage.migratePackage.mockResolvedValue(
        new Map([[1, 'c'.repeat(64)]]),
      );
      packagesService.findOne.mockResolvedValue({
        id: targetPackageId,
        slug: 'hero-copy',
        room: { id: 3 },
      });

      await service.publishCopiedRevision({
        sourcePackageId: 5,
        targetPackageId,
      });

      expect(storage.migratePackage).toHaveBeenCalledWith(
        targetPackageId,
        [expect.objectContaining({ revision: 1 })],
      );
      expect(
        storage.migratePackage.mock.invocationCallOrder[0],
      ).toBeLessThan(storage.publishRevision.mock.invocationCallOrder[0]);
    });

    it('copies the latest published revision as revision 1', async () => {
      const sourcePackageId = 5;
      const targetPackageId = 12;
      const sourceRevision = 4;
      const script = Buffer.from('extends Node\n');
      const binary = Buffer.from([0, 1, 2, 3]);
      const files = [entry('a.gd', script), entry('b.bin', binary)];
      const contents = new Map([
        ['a.gd', script],
        ['b.bin', binary],
      ]);

      repository.findOne.mockResolvedValue(publishedRow(sourceRevision, files));
      storage.readPublishedFiles.mockResolvedValue(contents);
      packagesService.findOne.mockResolvedValue({
        id: targetPackageId,
        slug: 'hero-copy',
        room: { id: 3 },
      });

      const copied = await service.publishCopiedRevision({
        sourcePackageId,
        targetPackageId,
      });

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { package: { id: sourcePackageId }, status: 'published' },
        order: { revision: 'DESC' },
      });
      expect(storage.readPublishedFiles).toHaveBeenCalledWith(
        sourcePackageId,
        sourceRevision,
        ['a.gd', 'b.bin'],
        null,
      );
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 1, status: 'draft', files }),
      );
      expect(storage.saveDraftFile).toHaveBeenCalledWith(
        targetPackageId,
        1,
        'a.gd',
        script,
      );
      expect(storage.saveDraftFile).toHaveBeenCalledWith(
        targetPackageId,
        1,
        'b.bin',
        binary,
      );
      expect(storage.publishRevision).toHaveBeenCalledWith(
        targetPackageId,
        1,
        files,
        expect.any(Function),
      );
      expect(storage.writePinnedDependencies).toHaveBeenCalledWith(
        targetPackageId,
        1,
        new Map(),
      );
      expect(dispatcher.revisionPublished).toHaveBeenCalledWith(
        targetPackageId,
        1,
      );
      expect(copied).toMatchObject({
        packageId: targetPackageId,
        revision: 1,
        status: 'published',
      });
    });

    it('reads copied files in one batch', async () => {
      const sourcePackageId = 5;
      const targetPackageId = 12;
      const files = [
        entry('a.txt', Buffer.from('a')),
        entry('b.txt', Buffer.from('b')),
      ];
      repository.findOne.mockResolvedValue(publishedRow(2, files));
      storage.readPublishedFiles.mockResolvedValue(
        new Map([
          ['a.txt', Buffer.from('a')],
          ['b.txt', Buffer.from('b')],
        ]),
      );
      packagesService.findOne.mockResolvedValue({
        id: targetPackageId,
        slug: 'copy',
        room: { id: 3 },
      });

      await service.publishCopiedRevision({
        sourcePackageId,
        targetPackageId,
      });

      expect(storage.readPublishedFiles).toHaveBeenCalledTimes(1);
      expect(storage.readPublishedFiles.mock.calls[0][2]).toEqual([
        'a.txt',
        'b.txt',
      ]);
    });

    it('applies transformFile and recomputes sha256', async () => {
      const sourcePackageId = 5;
      const targetPackageId = 12;
      const original = Buffer.from('preload("res://packages/old/lib.gd")\n');
      const transformFile = (filepath: string, data: Buffer): Buffer =>
        filepath.endsWith('.gd')
          ? Buffer.from(
              data
                .toString('utf8')
                .split('res://packages/old/')
                .join('res://packages/newer/'),
            )
          : data;
      const rewritten = transformFile('main.gd', original);

      repository.findOne.mockResolvedValue(
        publishedRow(2, [entry('main.gd', original)]),
      );
      storage.readPublishedFiles.mockResolvedValue(
        new Map([['main.gd', original]]),
      );
      storage.readDraftFile.mockResolvedValue(rewritten.toString('utf8'));
      packagesService.findOne.mockResolvedValue({
        id: targetPackageId,
        slug: 'newer',
        room: { id: 3 },
      });
      packagesRepository.find.mockImplementation(
        (opts?: { select?: unknown }) =>
          opts?.select ? [{ id: targetPackageId, slug: 'newer' }] : [],
      );

      const copied = await service.publishCopiedRevision({
        sourcePackageId,
        targetPackageId,
        transformFile,
      });

      expect(rewritten.byteLength).toBe(original.byteLength + 2);
      expect(storage.saveDraftFile).toHaveBeenCalledWith(
        targetPackageId,
        1,
        'main.gd',
        rewritten,
      );
      const [, , declared] = storage.publishRevision.mock.calls[0] as [
        number,
        number,
        PackageFileEntry[],
        () => Promise<void>,
      ];
      expect(declared).toEqual([
        {
          filepath: 'main.gd',
          size: rewritten.byteLength,
          sha256: sha256Hex(rewritten),
        },
      ]);
      expect(declared[0].sha256).not.toBe(sha256Hex(original));
      expect(copied.files).toEqual(declared);
    });

    it('rejects a global target that references a room package', async () => {
      const text = Buffer.from('preload("res://packages/6/lib.gd")\n');

      repository.findOne.mockResolvedValue(
        publishedRow(1, [entry('main.gd', text)]),
      );
      storage.readPublishedFiles.mockResolvedValue(
        new Map([['main.gd', text]]),
      );
      storage.readDraftFile.mockResolvedValue(text.toString('utf8'));
      packagesService.findOne.mockResolvedValue({
        id: 12,
        slug: 'hero-copy',
        room: null,
      });
      packagesRepository.find.mockImplementation(
        (opts?: { select?: unknown }) =>
          opts?.select ? [] : [{ id: 6, slug: 'hero', room: { id: 3 } }],
      );

      await expect(
        service.publishCopiedRevision({
          sourcePackageId: 5,
          targetPackageId: 12,
        }),
      ).rejects.toMatchObject({
        response: { code: 'package_dependency_not_global', slug: 'hero' },
      });
      expect(storage.publishRevision).not.toHaveBeenCalled();
      expect(repository.delete).toHaveBeenCalledWith(1);
    });

    it('removes the revision row when publishing the copied bytes fails', async () => {
      const data = Buffer.from('extends Node\n');

      repository.findOne.mockResolvedValue(
        publishedRow(2, [entry('a.gd', data)]),
      );
      storage.readPublishedFiles.mockResolvedValue(
        new Map([['a.gd', data]]),
      );
      packagesService.findOne.mockResolvedValue({
        id: 12,
        slug: 'hero-copy',
        room: { id: 3 },
      });
      storage.publishRevision.mockRejectedValue(new Error('disk full'));

      await expect(
        service.publishCopiedRevision({
          sourcePackageId: 5,
          targetPackageId: 12,
        }),
      ).rejects.toThrow('disk full');
      expect(repository.delete).toHaveBeenCalledWith(1);
      expect(storage.discardDraft).toHaveBeenCalledWith(12, 1);
    });

    it('keeps the original error when cleaning up the failed copy also fails', async () => {
      const data = Buffer.from('extends Node\n');

      repository.findOne.mockResolvedValue(
        publishedRow(2, [entry('a.gd', data)]),
      );
      storage.readPublishedFiles.mockResolvedValue(
        new Map([['a.gd', data]]),
      );
      packagesService.findOne.mockResolvedValue({
        id: 12,
        slug: 'hero-copy',
        room: { id: 3 },
      });
      storage.publishRevision.mockRejectedValue(new Error('disk full'));
      repository.delete.mockRejectedValue(new Error('database gone'));
      storage.discardDraft.mockRejectedValue(new Error('disk busy'));
      const warn = jest
        .spyOn(
          (service as unknown as { logger: { warn: jest.Mock } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await expect(
        service.publishCopiedRevision({
          sourcePackageId: 5,
          targetPackageId: 12,
        }),
      ).rejects.toThrow('disk full');

      expect(repository.delete).toHaveBeenCalledWith(1);
      expect(storage.discardDraft).toHaveBeenCalledWith(12, 1);
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });
  });
});
