import { makeRepository, TestRepository } from '../../testing/git-test-helpers';

describe('PackageGitRepository', () => {
  let fixture: TestRepository;

  beforeEach(() => {
    fixture = makeRepository();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('creates a bare sha256 repository once', async () => {
    const { repo } = fixture;
    await repo.ensureRepo(7);
    await repo.ensureRepo(7);

    const format = await repo.command.run(
      ['config', '--get', 'extensions.objectformat'],
      { cwd: repo.repoDir(7) },
    );
    expect(format.toString().trim()).toBe('sha256');

    const bare = await repo.command.run(['rev-parse', '--is-bare-repository'], {
      cwd: repo.repoDir(7),
    });
    expect(bare.toString().trim()).toBe('true');

    await expect(repo.hasRepo(7)).resolves.toBe(true);
  });

  it('reports the installed git version', async () => {
    const version = await fixture.repo.version();

    expect(version.major).toBeGreaterThanOrEqual(2);
    expect(version.raw).toMatch(/^git version /);
  });
});
