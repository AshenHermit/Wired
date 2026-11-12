import { Buffer } from 'node:buffer';
import type { PackageGitRepository } from './package-git-repository';
import { makeRepository, TestRepository } from '../../testing/git-test-helpers';

const AUTHOR = { name: 'Wired', email: 'packages@wired.local' };
const DATE = new Date('2024-01-01T00:00:00Z');

describe('PackageGitRepository refs and blobs', () => {
  let context: TestRepository;
  let repo: PackageGitRepository;

  beforeEach(async () => {
    context = makeRepository();
    repo = context.repo;
    await repo.ensureRepo(1);
  });

  afterEach(() => context.cleanup());

  async function commitFile(
    content: string,
    parent: string | null = null,
  ): Promise<string> {
    const oids = await repo.writeBlobs(1, [
      { path: 'file.txt', data: Buffer.from(content) },
    ]);
    const tree = await repo.writeTree(1, [
      { path: 'file.txt', oid: oids.get('file.txt')! },
    ]);
    return repo.createCommit(1, tree, parent, AUTHOR, content, DATE);
  }

  it('creates, updates and deletes refs atomically', async () => {
    const oid = await commitFile('a');
    await repo.applyRefUpdates(1, [
      { ref: 'refs/pending/publish/1', oid, expected: null },
    ]);
    expect(await repo.readRef(1, 'refs/pending/publish/1')).toBe(oid);

    await repo.applyRefUpdates(1, [
      { ref: 'refs/tags/revisions/1', oid, expected: null },
      { ref: 'refs/heads/main', oid, expected: null },
      { ref: 'refs/pending/publish/1', delete: true, expected: oid },
    ]);

    expect(await repo.readRef(1, 'refs/pending/publish/1')).toBeNull();
    expect(await repo.readRef(1, 'refs/tags/revisions/1')).toBe(oid);
    expect(await repo.readRef(1, 'refs/heads/main')).toBe(oid);
  });

  it('leaves all refs untouched when an expected value is stale', async () => {
    const oid = await commitFile('a');
    const other = await commitFile('b', oid);

    await expect(
      repo.applyRefUpdates(1, [
        { ref: 'refs/tags/revisions/2', oid: other, expected: null },
        { ref: 'refs/heads/main', oid: other, expected: 'deadbeef' },
      ]),
    ).rejects.toBeTruthy();

    expect(await repo.readRef(1, 'refs/tags/revisions/2')).toBeNull();
    expect(await repo.readRef(1, 'refs/heads/main')).toBeNull();
  });

  it('streams blobs in input order', async () => {
    const oids = await repo.writeBlobs(1, [
      { path: 'a.txt', data: Buffer.from('a') },
      { path: 'b.txt', data: Buffer.from('b') },
    ]);

    const seen: string[] = [];
    await repo.forEachBlob(
      1,
      [oids.get('b.txt')!, oids.get('a.txt')!],
      (_oid, data) => {
        seen.push(data.toString());
      },
    );

    expect(seen).toEqual(['b', 'a']);
  });

  it('reads the commit date', async () => {
    const oid = await commitFile('a');

    expect((await repo.commitDate(1, oid)).toISOString()).toBe(
      DATE.toISOString(),
    );
  });

  it('lists refs by prefix', async () => {
    const oid = await commitFile('a');
    await repo.applyRefUpdates(1, [
      { ref: 'refs/tags/revisions/1', oid, expected: null },
      { ref: 'refs/heads/main', oid, expected: null },
    ]);

    expect(await repo.listRefs(1, 'refs/tags/')).toEqual([
      { ref: 'refs/tags/revisions/1', oid },
    ]);
  });

  it('fsck succeeds and gc keeps reachable objects', async () => {
    const oid = await commitFile('a');
    await repo.applyRefUpdates(1, [
      { ref: 'refs/heads/main', oid, expected: null },
    ]);

    await expect(repo.fsck(1)).resolves.toBeUndefined();
    await expect(repo.gc(1, 'now')).resolves.toBeUndefined();
    expect(await repo.objectExists(1, [oid])).toContain(oid);
  });
});
