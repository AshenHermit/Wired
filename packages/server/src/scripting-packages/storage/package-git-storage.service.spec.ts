import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AppConfigService } from '../../config/config.service';
import type { ScriptingPackageRevision } from '../../database/entities/scripting-package-revision.entity';
import { PackageGitRepository } from './git/package-git-repository';
import { PackageContentIndex } from './git/package-content-index';
import { PackageGitStorageService } from './package-git-storage.service';
import { sha256Hex } from './package-hash';
import { PackageStorageService } from './package-storage.service';
import {
  makeRepository,
  writeLegacyFile,
} from '../testing/git-test-helpers';

describe('PackageGitStorageService', () => {
  let repo: PackageGitRepository;
  let root: string;
  let cleanup: () => void;
  let storage: PackageStorageService;
  let gitStorage: PackageGitStorageService;
  let index: PackageContentIndex;
  let rows: ScriptingPackageRevision[];

  const author = { name: 'Wired', email: 'packages@wired.local' };
  const filesA = [{ path: 'a.txt', content: 'A' }];
  const fileB = { path: 'b.txt', content: 'B' };

  const entry = (filepath: string, content: string) => ({
    filepath,
    size: Buffer.byteLength(content),
    sha256: sha256Hex(Buffer.from(content)),
  });

  async function publish(
    revision: number,
    files: Array<{ path: string; content: string }>,
    stage = true,
  ): Promise<void> {
    const declared = files.map((file) => entry(file.path, file.content));
    if (stage) {
      for (const file of files) {
        await storage.saveDraftFile(
          1,
          revision,
          file.path,
          Buffer.from(file.content),
        );
      }
    }
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

  const commit = async (
    packageId: number,
    revision: number,
    files: Array<{ path: string; content: string }>,
  ): Promise<string> => {
    const oids = await repo.writeBlobs(
      packageId,
      files.map((file) => ({
        path: file.path,
        data: Buffer.from(file.content),
      })),
    );
    const tree = await repo.writeTree(
      packageId,
      files.map((file) => ({ path: file.path, oid: oids.get(file.path)! })),
    );
    const oid = await repo.createCommit(
      packageId,
      tree,
      null,
      { name: 'Wired', email: 'packages@wired.local' },
      `revision ${revision}`,
      new Date('2024-01-01T00:00:00Z'),
    );
    await repo.applyRefUpdates(packageId, [
      {
        ref: `refs/tags/revisions/${revision}`,
        oid,
        expected: null,
      },
    ]);
    return oid;
  };

  beforeEach(async () => {
    ({ repo, root, cleanup } = makeRepository());
    await repo.ensureRepo(1);
    rows = [];
    const revisions = {
      find: jest.fn(async () => rows),
    } as unknown as Repository<ScriptingPackageRevision>;
    index = new PackageContentIndex(repo, revisions);
    gitStorage = new PackageGitStorageService(repo, index);
    const config = {
      storage: { dir: root, packagesFilesDir: root },
      packages: { gitStorage: true },
    } as unknown as AppConfigService;
    storage = new PackageStorageService(config, gitStorage);
  });

  afterEach(() => {
    cleanup();
  });

  it('reads a git revision by commit sha', async () => {
    const sha = await commit(1, 1, [
      { path: 'scripts/player.gd', content: 'extends Node\n' },
    ]);

    const data = await storage.readPublishedFile(
      1,
      1,
      'scripts/player.gd',
      sha,
    );

    expect(data.toString()).toBe('extends Node\n');
  });

  it('falls back to the legacy directory without a repo', async () => {
    writeLegacyFile(root, 2, 4, 'a.txt', 'legacy');

    const data = await storage.readPublishedFile(2, 4, 'a.txt', null);

    expect(data).toEqual(Buffer.from('legacy'));
  });

  it('returns a stream with the declared size', async () => {
    const sha = await commit(1, 1, [
      { path: 'scripts/player.gd', content: 'extends Node\n' },
    ]);

    const file = await storage.resolvePublishedFile(
      1,
      1,
      'scripts/player.gd',
      sha,
    );

    expect(file.size).toBe(13);
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe('extends Node\n');
  });

  it('reports files whose content is absent from the index', async () => {
    await publish(1, filesA);

    await expect(
      gitStorage.missingFiles(1, [entry('a.txt', 'A')]),
    ).resolves.toEqual([]);
    await expect(
      gitStorage.missingFiles(1, [entry('a.txt', 'A'), entry('b.txt', 'B')]),
    ).resolves.toEqual(['b.txt']);
  });

  it('does not stage blobs on an unchanged second publish', async () => {
    await publish(1, filesA);
    const spy = jest.spyOn(repo, 'writeStagedBlobs');

    await publish(2, filesA, false);

    expect(spy).not.toHaveBeenCalled();
    const commit = await repo.readRef(1, 'refs/tags/revisions/2');
    expect(commit).toBeTruthy();
    const tree = await repo.listTree(1, commit!);
    expect([...tree.keys()]).toEqual(['a.txt']);
  });

  it('accepts a subset of staged files and reuses indexed blobs', async () => {
    await publish(1, filesA);
    await storage.saveDraftFile(1, 2, 'b.txt', Buffer.from(fileB.content));

    await storage.publishRevision(
      1,
      2,
      [entry('a.txt', 'A'), entry('b.txt', 'B')],
      async (commitSha) => {
        rows.push({
          revision: 2,
          status: 'published',
          commitSha,
          files: [entry('a.txt', 'A'), entry('b.txt', 'B')],
        } as ScriptingPackageRevision);
      },
      author,
    );

    const commit = await repo.readRef(1, 'refs/tags/revisions/2');
    const tree = await repo.listTree(1, commit!);
    expect([...tree.keys()].sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('rejects a stale skipped blob with 409', async () => {
    await publish(1, filesA);
    await storage.saveDraftFile(1, 2, 'b.txt', Buffer.from(fileB.content));
    jest.spyOn(index, 'resolveOids').mockRejectedValue(
      new ConflictException({
        code: 'package_storage_stale',
        message: 'Package files must be uploaded again',
      }),
    );

    await expect(
      storage.publishRevision(
        1,
        2,
        [entry('a.txt', 'A'), entry('b.txt', 'B')],
        async () => undefined,
        author,
      ),
    ).rejects.toMatchObject({
      response: { code: 'package_storage_stale' },
    });
    expect(await repo.readRef(1, 'refs/tags/revisions/2')).toBeNull();
  });

  it('keeps a pending ref when ref promotion fails after the DB commit', async () => {
    await publish(1, filesA);
    const original = repo.applyRefUpdates.bind(repo);
    let calls = 0;
    jest.spyOn(repo, 'applyRefUpdates').mockImplementation(async (id, updates) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('ref failed');
      }
      await original(id, updates);
    });

    await publish(2, filesA, false);

    expect(
      await repo.readRef(1, 'refs/pending/publish/2'),
    ).toBeTruthy();
  });
});
