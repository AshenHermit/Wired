import { TestRepository, makeRepository } from '../../testing/git-test-helpers';

describe('PackageGitRepository objects', () => {
  let ctx: TestRepository;

  beforeEach(() => {
    ctx = makeRepository();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('builds a nested tree and deduplicates identical blobs', async () => {
    await ctx.repo.ensureRepo(1);
    const oids = await ctx.repo.writeBlobs(1, [
      { path: 'scripts/player.gd', data: Buffer.from('extends Node\n') },
      { path: 'assets/models/hero.gltf', data: Buffer.from('{}') },
      { path: 'copy.gltf', data: Buffer.from('{}') },
    ]);
    expect(oids.get('assets/models/hero.gltf')).toBe(oids.get('copy.gltf'));
    const tree = await ctx.repo.writeTree(
      1,
      [...oids].map(([path, oid]) => ({ path, oid })),
    );
    const files = await ctx.repo.listTree(1, tree);
    expect([...files.keys()].sort()).toEqual([
      'assets/models/hero.gltf',
      'copy.gltf',
      'scripts/player.gd',
    ]);
  });

  it('rejects symlinks in a tree', async () => {
    await ctx.repo.ensureRepo(1);
    const oids = await ctx.repo.writeBlobs(1, [
      { path: 'target.txt', data: Buffer.from('x') },
    ]);
    const target = oids.get('target.txt')!;
    const link = (
      await ctx.repo.command.run(['hash-object', '-w', '--stdin'], {
        cwd: ctx.repo.repoDir(1),
        input: 'target.txt',
      })
    )
      .toString()
      .trim();
    const tree = (
      await ctx.repo.command.run(['mktree'], {
        cwd: ctx.repo.repoDir(1),
        input: `100644 blob ${target}\ttarget.txt\n120000 blob ${link}\tlink\n`,
      })
    )
      .toString()
      .trim();
    const commit = await ctx.repo.createCommit(
      1,
      tree,
      null,
      { name: 'Test', email: 'test@wired.local' },
      'symlink',
      new Date(),
    );

    await expect(ctx.repo.listTree(1, commit)).rejects.toThrow(
      /non-regular tree entry/,
    );
  });

  it('reports which objects exist', async () => {
    await ctx.repo.ensureRepo(1);
    const oids = await ctx.repo.writeBlobs(1, [
      { path: 'a.txt', data: Buffer.from('a') },
    ]);
    const existing = oids.get('a.txt')!;
    const missing = '0'.repeat(64);

    const found = await ctx.repo.objectExists(1, [existing, missing]);

    expect(found.has(existing)).toBe(true);
    expect(found.has(missing)).toBe(false);
  });
});
