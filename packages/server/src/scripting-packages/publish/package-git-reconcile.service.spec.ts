import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { makeRepository, TestRepository } from '../testing/git-test-helpers';
import { PackagePublishLockService } from './package-publish-lock.service';
import { PackageGitReconcileService } from './package-git-reconcile.service';

const AUTHOR = { name: 'Wired', email: 'packages@wired.local' };
const DATE = new Date('2024-01-01T00:00:00Z');

function row(
  revision: number,
  status: 'draft' | 'published',
  commitSha: string | null,
): ScriptingPackageRevision {
  return {
    revision,
    status,
    commitSha,
    publishedAt: status === 'published' ? DATE : null,
    files: [],
    createdAt: DATE,
  } as unknown as ScriptingPackageRevision;
}

describe('PackageGitReconcileService', () => {
  let context: TestRepository;
  let revisions: ScriptingPackageRevision[];
  let repository: {
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
  };
  let service: PackageGitReconcileService;
  let locks: { runWithPublishLocks: jest.Mock };

  beforeEach(async () => {
    context = makeRepository();
    await context.repo.ensureRepo(1);
    revisions = [];
    repository = {
      findOne: jest.fn(
        async (options: { where: { revision: number } }) =>
          revisions.find(
            (item) => item.revision === options.where.revision,
          ) ?? null,
      ),
      find: jest.fn(async () => revisions),
      update: jest.fn(
        async (
          criteria: { revision: number },
          patch: Partial<ScriptingPackageRevision>,
        ) => {
          const target = revisions.find(
            (item) => item.revision === criteria.revision,
          );
          if (target) {
            Object.assign(target, patch);
          }
        },
      ),
      save: jest.fn(async (value: ScriptingPackageRevision) => value),
    };
    locks = {
      runWithPublishLocks: jest.fn(
        async (_ids: number[], fn: () => Promise<unknown>) => fn(),
      ),
    };
    service = new PackageGitReconcileService(
      context.repo,
      repository as unknown as Repository<ScriptingPackageRevision>,
      locks as unknown as PackagePublishLockService,
    );
  });

  afterEach(() => {
    context.cleanup();
  });

  async function makeCommit(content: string): Promise<string> {
    const oids = await context.repo.writeBlobs(1, [
      { path: 'a.txt', data: Buffer.from(content) },
    ]);
    const tree = await context.repo.writeTree(1, [
      { path: 'a.txt', oid: oids.get('a.txt')! },
    ]);
    return context.repo.createCommit(
      1,
      tree,
      null,
      AUTHOR,
      content,
      DATE,
    );
  }

  async function pending(revision: number, oid: string): Promise<void> {
    await context.repo.applyRefUpdates(1, [
      { ref: `refs/pending/publish/${revision}`, oid, expected: null },
    ]);
  }

  it('finishes refs for a published row whose pending ref matches', async () => {
    const commit = await makeCommit('a');
    await pending(1, commit);
    revisions = [row(1, 'published', commit)];

    await service.reconcilePackage(1);

    await expect(context.repo.readRef(1, 'refs/tags/revisions/1')).resolves.toBe(
      commit,
    );
    await expect(context.repo.readRef(1, 'refs/heads/main')).resolves.toBe(
      commit,
    );
    await expect(
      context.repo.readRef(1, 'refs/pending/publish/1'),
    ).resolves.toBeNull();
  });

  it('drops a pending ref that never reached the database', async () => {
    const commit = await makeCommit('a');
    await pending(2, commit);
    revisions = [row(2, 'draft', null)];

    await service.reconcilePackage(1);

    await expect(
      context.repo.readRef(1, 'refs/pending/publish/2'),
    ).resolves.toBeNull();
    await expect(
      context.repo.readRef(1, 'refs/tags/revisions/2'),
    ).resolves.toBeNull();
  });

  it('promotes a draft row whose tag already exists', async () => {
    const commit = await makeCommit('a');
    await context.repo.applyRefUpdates(1, [
      { ref: 'refs/tags/revisions/1', oid: commit, expected: null },
    ]);
    revisions = [row(1, 'draft', null)];

    await service.reconcilePackage(1);

    expect(repository.update).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1 }),
      expect.objectContaining({
        status: 'published',
        commitSha: commit,
        publishedAt: expect.any(Date),
      }),
    );
    expect(revisions[0].status).toBe('published');
    expect(revisions[0].commitSha).toBe(commit);
  });

  it('is idempotent when refs are already consistent', async () => {
    const commit = await makeCommit('a');
    await pending(1, commit);
    revisions = [row(1, 'published', commit)];

    await service.reconcilePackage(1);
    await service.reconcilePackage(1);

    await expect(context.repo.readRef(1, 'refs/tags/revisions/1')).resolves.toBe(
      commit,
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('runs under the publish lock of the package', async () => {
    await service.reconcilePackage(1);

    expect(locks.runWithPublishLocks).toHaveBeenCalledWith(
      [1],
      expect.any(Function),
    );
  });

  it('leaves refs untouched when another instance holds the publish lock', async () => {
    const commit = await makeCommit('a');
    await pending(1, commit);
    revisions = [row(1, 'published', commit)];
    locks.runWithPublishLocks.mockRejectedValueOnce(
      new ConflictException('Package 1 is being published'),
    );

    await expect(service.reconcilePackage(1)).rejects.toBeInstanceOf(
      ConflictException,
    );

    await expect(
      context.repo.readRef(1, 'refs/pending/publish/1'),
    ).resolves.toBe(commit);
    await expect(
      context.repo.readRef(1, 'refs/tags/revisions/1'),
    ).resolves.toBeNull();
  });
});
