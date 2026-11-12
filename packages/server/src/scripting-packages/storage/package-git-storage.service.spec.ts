import type { AppConfigService } from '../../config/config.service';
import { PackageGitRepository } from './git/package-git-repository';
import { PackageGitStorageService } from './package-git-storage.service';
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
    const config = {
      storage: { dir: root, packagesFilesDir: root },
      packages: { gitStorage: true },
    } as unknown as AppConfigService;
    storage = new PackageStorageService(
      config,
      new PackageGitStorageService(repo),
    );
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
});
