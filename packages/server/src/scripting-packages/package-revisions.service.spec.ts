import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PackageFileEntry, PackageRevision } from '@wired-io/shared';
import { DataSource } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { sha256Hex } from './package-hash';
import { PackageRevisionsService } from './package-revisions.service';
import { PackageStorageService } from './package-storage.service';
import { ScriptingPackagesService } from './scripting-packages.service';
import type { PackageRevisionDispatcher } from 'src/godot-game/package-sync.types';

const pkg = {
  id: 7,
  name: 'Heroes',
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

describe('PackageRevisionsService', () => {
  let repository: {
    maximum: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
  };
  let packagesService: { findOne: jest.Mock };
  let storage: {
    saveDraftFile: jest.Mock;
    publishRevision: jest.Mock;
    discardDraft: jest.Mock;
    readPublishedFile: jest.Mock;
    resolvePublishedFile: jest.Mock;
    writePinnedDependencies: jest.Mock;
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
    };
    packagesService = { findOne: jest.fn(async () => pkg) };
    dispatcher = { revisionPublished: jest.fn(async () => undefined) };
    storage = {
      saveDraftFile: jest.fn(async (_id, _rev, _path, data: Buffer) => ({
        size: data.byteLength,
        sha256: sha256Hex(data),
      })),
      publishRevision: jest.fn(async (_id, _rev, _files, commit) => commit()),
      discardDraft: jest.fn(async () => undefined),
      readPublishedFile: jest.fn(async () => Buffer.from('x')),
      resolvePublishedFile: jest.fn(async () => ({
        path: '/tmp/a.txt',
        size: 1,
      })),
      writePinnedDependencies: jest.fn(async () => undefined),
    };
    service = new PackageRevisionsService(
      repository as never,
      packagesService as unknown as ScriptingPackagesService,
      storage as unknown as PackageStorageService,
      dispatcher as unknown as PackageRevisionDispatcher,
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
      );
      expect(published.status).toBe('published');
      expect(published.publishedAt).toEqual(expect.any(String));
      expect(dispatcher.revisionPublished).toHaveBeenCalledWith(7, 3);
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
      storage.readPublishedFile.mockResolvedValue(
        Buffer.from('preload("res://packages/6/lib.gd")'),
      );

      await service.publish(7, 3);

      expect(storage.writePinnedDependencies).toHaveBeenCalledWith(
        7,
        3,
        new Map([[6, 9]]),
      );
    });

    it('keeps the publication even when the pins cannot be recorded', async () => {
      repository.findOne.mockResolvedValue(
        draftRow(3, [file('main.gd', 'preload("res://packages/6/lib.gd")')]),
      );
      storage.readPublishedFile.mockResolvedValue(
        Buffer.from('preload("res://packages/6/lib.gd")'),
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
        revision: 3,
        totalSize: 5,
        publishedAt: '2026-10-29T11:00:00.000Z',
      });
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
      expect(storage.resolvePublishedFile).toHaveBeenCalledWith(7, 3, 'a.txt');
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
        dispatcher as unknown as PackageRevisionDispatcher,
        dataSource as unknown as DataSource,
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
});
