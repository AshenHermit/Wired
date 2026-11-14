import { ConflictException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

  it('streams the published blob instead of buffering it', async () => {
    const sha = await commit(1, 1, [{ path: 'a.txt', content: 'A' }]);
    const openBlob = jest.spyOn(repo, 'openBlob');

    const stream = await gitStorage.openFile(1, 1, 'a.txt', sha);

    expect(openBlob).toHaveBeenCalledTimes(1);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe('A');
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

  const rewrittenScene = 'res://packages/old/main.tscn';

  const commitScene = (revision: number): Promise<string> =>
    commit(1, revision, [{ path: 'main.tscn', content: rewrittenScene }]);

  const slugTransform = (_filepath: string, data: Buffer): Buffer =>
    Buffer.from(
      data.toString('utf8').split('packages/old/').join('packages/new/'),
    );

  it('rewrites published revisions as new commits and moves tags', async () => {
    const tag1 = await commitScene(1);
    const tag2 = await commitScene(2);

    const rewrite = await storage.beginRewrite(
      [
        { packageId: 1, revision: 1, kind: 'published', commitSha: tag1 },
        { packageId: 1, revision: 2, kind: 'published', commitSha: tag2 },
      ],
      slugTransform,
    );

    expect(
      rewrite.results.map((result) => result.commitSha),
    ).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(rewrite.results[0].commitSha).not.toBe(tag1);
    expect(rewrite.results[1].commitSha).not.toBe(tag2);

    await rewrite.commit();

    expect(await repo.readRef(1, 'refs/tags/revisions/1')).not.toBe(tag1);
    const moved = await repo.readRef(1, 'refs/tags/revisions/2');
    expect(moved).toBe(rewrite.results[1].commitSha);
    expect(await repo.readRef(1, 'refs/heads/main')).toBe(moved);
    expect(await repo.readRef(1, 'refs/pending/rewrite/2')).toBeNull();

    const files = await storage.readPublishedFiles(1, 2, ['main.tscn'], moved);
    expect(files.get('main.tscn')!.toString()).toContain('packages/new/');
  });

  it('restores the tags when the database transaction fails', async () => {
    const tag1 = await commitScene(1);
    const tag2 = await commitScene(2);

    const rewrite = await storage.beginRewrite(
      [
        { packageId: 1, revision: 1, kind: 'published', commitSha: tag1 },
        { packageId: 1, revision: 2, kind: 'published', commitSha: tag2 },
      ],
      slugTransform,
    );
    await rewrite.abort();

    expect(await repo.readRef(1, 'refs/tags/revisions/1')).toBe(tag1);
    expect(await repo.readRef(1, 'refs/tags/revisions/2')).toBe(tag2);
    expect(await repo.readRef(1, 'refs/pending/rewrite/1')).toBeNull();
    const files = await storage.readPublishedFiles(1, 1, ['main.tscn'], tag1);
    expect(files.get('main.tscn')!.toString()).toBe(rewrittenScene);
  });

  const legacyDir = (packageId: number, revision: number): string =>
    join(root, String(packageId), 'revisions', String(revision));

  const legacyRows = (
    contents: Array<{ revision: number; filepath: string; content: string }>,
  ) =>
    contents.map(({ revision, filepath, content }) => ({
      revision,
      files: [entry(filepath, content)],
      publishedAt: new Date(`2024-01-0${revision}T00:00:00Z`),
    }));

  it('converts legacy revisions into a linear history', async () => {
    const source = 'extends Node\n// res://packages/old/player.gd';
    writeLegacyFile(root, 1, 1, 'scripts/player.gd', source);
    writeLegacyFile(root, 1, 2, 'scripts/player.gd', `${source}\n`);
    const rows = legacyRows([
      { revision: 1, filepath: 'scripts/player.gd', content: source },
      { revision: 2, filepath: 'scripts/player.gd', content: `${source}\n` },
    ]);

    const commits = await storage.migratePackage(1, rows);

    expect(commits.size).toBe(2);
    expect(await repo.readRef(1, 'refs/tags/revisions/1')).toBe(
      commits.get(1),
    );
    expect(await repo.readRef(1, 'refs/tags/revisions/2')).toBe(
      commits.get(2),
    );
    expect(await repo.readRef(1, 'refs/heads/main')).toBe(commits.get(2));
    const second = await repo.listTree(1, commits.get(2)!);
    expect(second.has('scripts/player.gd')).toBe(true);
    await expect(
      storage.readPublishedFile(
        1,
        2,
        'scripts/player.gd',
        commits.get(2)!,
      ),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('keeps legacy directories until cleanup', async () => {
    const source = 'extends Node\n';
    writeLegacyFile(root, 1, 1, 'a.gd', source);
    writeLegacyFile(root, 1, 2, 'a.gd', source);
    const rows = legacyRows([
      { revision: 1, filepath: 'a.gd', content: source },
      { revision: 2, filepath: 'a.gd', content: source },
    ]);

    const commits = await storage.migratePackage(1, rows);

    expect(existsSync(legacyDir(1, 1))).toBe(true);
    const removed = await storage.cleanupLegacyRevisions(
      1,
      rows.map((row) => ({ ...row, commitSha: commits.get(row.revision)! })),
    );
    expect(removed).toBe(2);
    expect(existsSync(legacyDir(1, 1))).toBe(false);
    expect(existsSync(legacyDir(1, 2))).toBe(false);
  });

  it('refuses cleanup while a row has no commit', async () => {
    await expect(
      storage.cleanupLegacyRevisions(1, [
        { revision: 1, files: [], publishedAt: null, commitSha: null },
      ]),
    ).rejects.toThrow(/not converted/);
  });

  it('refuses cleanup when the recorded commit is missing from the repository', async () => {
    writeLegacyFile(root, 1, 1, 'a.gd', 'extends Node\n');

    await expect(
      storage.cleanupLegacyRevisions(1, [
        {
          revision: 1,
          files: [entry('a.gd', 'extends Node\n')],
          publishedAt: null,
          commitSha: 'f'.repeat(64),
        },
      ]),
    ).rejects.toThrow(/has no commit/);
    expect(existsSync(legacyDir(1, 1))).toBe(true);
  });

  it('refuses cleanup when a tag does not point at the recorded commit', async () => {
    writeLegacyFile(root, 1, 1, 'a.gd', 'extends Node\n');
    await commit(1, 1, [{ path: 'a.gd', content: 'extends Node\n' }]);
    const other = await commit(1, 2, [{ path: 'a.gd', content: 'other' }]);

    await expect(
      storage.cleanupLegacyRevisions(1, [
        {
          revision: 1,
          files: [entry('a.gd', 'extends Node\n')],
          publishedAt: null,
          commitSha: other,
        },
      ]),
    ).rejects.toThrow(/tag/);
    expect(existsSync(legacyDir(1, 1))).toBe(true);
  });

  it('rejects a skipped blob whose object was pruned', async () => {
    await publish(1, filesA);
    // Warm the content index before the objects become unreachable.
    await expect(
      gitStorage.missingFiles(1, [entry('a.txt', 'A')]),
    ).resolves.toEqual([]);
    const tag = await repo.readRef(1, 'refs/tags/revisions/1');
    const main = await repo.readRef(1, 'refs/heads/main');
    await repo.applyRefUpdates(1, [
      { ref: 'refs/tags/revisions/1', delete: true, expected: tag! },
      { ref: 'refs/heads/main', delete: true, expected: main! },
    ]);
    await repo.gc(1, 'now');

    await expect(
      storage.publishRevision(
        1,
        2,
        [entry('a.txt', 'A')],
        async () => undefined,
        author,
      ),
    ).rejects.toMatchObject({
      response: { code: 'package_storage_stale' },
    });
    expect(await repo.readRef(1, 'refs/tags/revisions/2')).toBeNull();
  });
});
