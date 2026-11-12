import { createHash } from 'node:crypto';
import type { Repository } from 'typeorm';
import { ScriptingPackageRevision } from '../../../database/entities/scripting-package-revision.entity';
import { makeRepository } from '../../testing/git-test-helpers';
import { PackageContentIndex } from './package-content-index';
import { PackageGitRepository } from './package-git-repository';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const entry = (filepath: string, content: string) => ({
  filepath,
  size: Buffer.byteLength(content),
  sha256: sha256(content),
});

describe('PackageContentIndex', () => {
  let repo: PackageGitRepository;
  let index: PackageContentIndex;
  let rows: ScriptingPackageRevision[];
  let cleanup: () => void;

  const revisions = {
    find: jest.fn(async () => rows),
  } as unknown as Repository<ScriptingPackageRevision>;

  beforeEach(async () => {
    const made = await makeRepository();
    repo = made.repo;
    cleanup = made.cleanup;
    await repo.ensureRepo(1);
    rows = [];
    index = new PackageContentIndex(repo, revisions);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    cleanup();
  });

  async function commitRevision(
    revision: number,
    files: Record<string, string>,
  ): Promise<string> {
    const entries = Object.entries(files);
    const oids = await repo.writeBlobs(
      1,
      entries.map(([path, data]) => ({ path, data: Buffer.from(data) })),
    );
    const tree = await repo.writeTree(
      1,
      [...oids].map(([path, oid]) => ({ path, oid })),
    );
    const commit = await repo.createCommit(
      1,
      tree,
      null,
      { name: 'Wired', email: 'packages@wired.local' },
      `revision ${revision}`,
      new Date('2024-01-01T00:00:00Z'),
    );
    await repo.applyRefUpdates(1, [
      {
        ref: `refs/tags/revisions/${revision}`,
        oid: commit,
        expected: null,
      },
    ]);
    rows.push({
      revision,
      status: 'published',
      commitSha: commit,
      files: entries.map(([path, data]) => entry(path, data)),
    } as ScriptingPackageRevision);
    return commit;
  }

  it('reports only files whose content is absent', async () => {
    await commitRevision(1, { 'a.txt': 'A', 'b.txt': 'B' });

    await expect(
      index.missing(1, [entry('a.txt', 'A'), entry('b.txt', 'B')]),
    ).resolves.toEqual([]);
    await expect(
      index.missing(1, [entry('a.txt', 'A'), entry('c.txt', 'C')]),
    ).resolves.toEqual(['c.txt']);
  });

  it('keeps a blob that was deleted in a later revision', async () => {
    await commitRevision(1, { 'old.txt': 'OLD' });
    await commitRevision(2, { 'new.txt': 'NEW' });

    await expect(index.missing(1, [entry('old.txt', 'OLD')])).resolves.toEqual(
      [],
    );
  });

  it('drops index entries whose object disappeared', async () => {
    await commitRevision(1, { 'a.txt': 'A' });
    jest.spyOn(repo, 'objectExists').mockResolvedValue(new Set());

    await expect(index.missing(1, [entry('a.txt', 'A')])).resolves.toEqual([
      'a.txt',
    ]);
  });

  it('returns 409 semantics for unresolved oids', async () => {
    await commitRevision(1, { 'a.txt': 'A' });

    await expect(
      index.resolveOids(1, [entry('c.txt', 'C')]),
    ).rejects.toMatchObject({
      response: { code: 'package_storage_stale' },
    });
  });
});
