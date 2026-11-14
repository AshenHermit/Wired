import { ConflictException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import type { AppConfigService } from 'src/config/config.service';
import type { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { makeRepository } from '../testing/git-test-helpers';
import { PackageContentIndex } from '../storage/git/package-content-index';
import { PackageGitRepository } from '../storage/git/package-git-repository';
import { sha256Hex } from '../storage/package-hash';
import { PackageGitStorageService } from '../storage/package-git-storage.service';
import { PackageStorageService } from '../storage/package-storage.service';
import { PackageGitReconcileService } from './package-git-reconcile.service';
import { PackageGitMaintenanceService } from './package-git-maintenance.service';
import { PackagePublishLockService } from './package-publish-lock.service';

describe('PackageGitMaintenanceService', () => {
  let repo: PackageGitRepository;
  let root: string;
  let cleanup: () => void;
  let config: AppConfigService;
  let storage: PackageStorageService;
  let reconcile: PackageGitReconcileService;
  let service: PackageGitMaintenanceService;
  let revisions: Repository<ScriptingPackageRevision>;
  let rows: ScriptingPackageRevision[];
  let locks: { runWithPublishLocks: jest.Mock };

  const author = { name: 'Wired', email: 'packages@wired.local' };

  const entry = (filepath: string, content: string) => ({
    filepath,
    size: Buffer.byteLength(content),
    sha256: sha256Hex(Buffer.from(content)),
  });

  async function publish(
    revision: number,
    filepath: string,
    content: string,
  ): Promise<void> {
    const declared = [entry(filepath, content)];
    await storage.saveDraftFile(1, revision, filepath, Buffer.from(content));
    await storage.publishRevision(
      1,
      revision,
      declared,
      async (commitSha) => {
        rows.push({
          revision,
          status: 'published',
          commitSha,
          files: declared,
        } as ScriptingPackageRevision);
      },
      author,
    );
  }

  beforeEach(async () => {
    ({ repo, root, cleanup } = makeRepository());
    await repo.ensureRepo(1);
    rows = [];
    revisions = {
      find: jest.fn(async (options?: { where?: { status?: string } }) => {
        const status = options?.where?.status;
        return rows.filter((row) => !status || row.status === status);
      }),
      findOne: jest.fn(async () => null),
    } as unknown as Repository<ScriptingPackageRevision>;
    const index = new PackageContentIndex(repo, revisions);
    const gitStorage = new PackageGitStorageService(repo, index);
    config = {
      storage: { dir: root, packagesFilesDir: root },
      packages: {
        gitStorage: true,
        gitGcExpire: 'now',
        gitGcIntervalMs: 60_000,
      },
    } as unknown as AppConfigService;
    storage = new PackageStorageService(config, gitStorage);
    reconcile = new PackageGitReconcileService(
      repo,
      revisions,
      new PackagePublishLockService(),
    );
    locks = {
      runWithPublishLocks: jest.fn(
        async (_ids: number[], fn: () => Promise<unknown>) => fn(),
      ),
    };
    service = new PackageGitMaintenanceService(
      config,
      repo,
      storage,
      reconcile,
      revisions,
      locks as unknown as PackagePublishLockService,
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('prunes unreachable objects after reconcile', async () => {
    const oids = await repo.writeBlobs(1, [
      { path: 'orphan.gd', data: Buffer.from('orphan') },
    ]);
    const tree = await repo.writeTree(1, [
      { path: 'orphan.gd', oid: oids.get('orphan.gd')! },
    ]);
    const orphan = await repo.createCommit(
      1,
      tree,
      null,
      author,
      'orphan',
      new Date('2024-01-01T00:00:00Z'),
    );
    const pending = 'refs/pending/publish/99';
    await repo.applyRefUpdates(1, [
      { ref: pending, oid: orphan, expected: null },
    ]);

    await service.maintainPackage(1);

    expect(await repo.readRef(1, pending)).toBeNull();
    await expect(repo.objectExists(1, [orphan])).resolves.toEqual(new Set());
  });

  it('exports published revisions back to directories', async () => {
    await publish(1, 'scripts/a.gd', 'extends Node\n');
    await publish(2, 'scripts/a.gd', 'extends Node\n# v2\n');

    const count = await service.exportPackage(1);

    expect(count).toBe(2);
    expect(
      readFileSync(join(root, '1', 'revisions', '2', 'scripts', 'a.gd'), 'utf8'),
    ).toBe('extends Node\n# v2\n');
  });

  it('restores a missing tag from the recorded commit', async () => {
    await publish(1, 'a.gd', 'A');
    const commitSha = rows[0].commitSha!;
    await repo.applyRefUpdates(1, [
      { ref: 'refs/tags/revisions/1', delete: true, expected: commitSha },
    ]);

    await service.repairPackage(1);

    expect(await repo.readRef(1, 'refs/tags/revisions/1')).toBe(commitSha);
  });

  it('does not start the interval when git storage is disabled', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const disabled = {
      storage: config.storage,
      packages: { ...config.packages, gitStorage: false },
    } as unknown as AppConfigService;
    const disabledService = new PackageGitMaintenanceService(
      disabled,
      repo,
      storage,
      reconcile,
      revisions,
      locks as unknown as PackagePublishLockService,
    );
    try {
      disabledService.onModuleInit();
    } finally {
      spy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('maintains a package under its publish lock', async () => {
    await service.maintainPackage(1);

    expect(locks.runWithPublishLocks).toHaveBeenCalledWith(
      [1],
      expect.any(Function),
    );
  });

  it('skips maintenance instead of racing a held publish lock', async () => {
    const oids = await repo.writeBlobs(1, [
      { path: 'live.gd', data: Buffer.from('live') },
    ]);
    const tree = await repo.writeTree(1, [
      { path: 'live.gd', oid: oids.get('live.gd')! },
    ]);
    const live = await repo.createCommit(
      1,
      tree,
      null,
      author,
      'live',
      new Date('2024-01-01T00:00:00Z'),
    );
    await repo.applyRefUpdates(1, [
      { ref: 'refs/tags/revisions/1', oid: live, expected: null },
    ]);
    rows.push({
      revision: 1,
      status: 'published',
      commitSha: live,
      files: [entry('live.gd', 'live')],
    } as ScriptingPackageRevision);
    locks.runWithPublishLocks.mockRejectedValueOnce(
      new ConflictException('Package 1 is being published'),
    );

    await expect(service.maintainPackage(1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(repo.objectExists(1, [live])).resolves.toEqual(new Set([live]));
  });

  it('continues with other packages when one maintenance run fails', async () => {
    rows.push(
      {
        revision: 1,
        status: 'published',
        commitSha: null,
        files: [],
        package: { id: 1 },
      } as unknown as ScriptingPackageRevision,
      {
        revision: 1,
        status: 'published',
        commitSha: null,
        files: [],
        package: { id: 2 },
      } as unknown as ScriptingPackageRevision,
    );
    locks.runWithPublishLocks.mockRejectedValueOnce(
      new ConflictException('Package 1 is being published'),
    );
    const spy = jest.spyOn(service, 'maintainPackage');

    await (service as unknown as { maintainAllPackages(): Promise<void> })
      .maintainAllPackages();

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
