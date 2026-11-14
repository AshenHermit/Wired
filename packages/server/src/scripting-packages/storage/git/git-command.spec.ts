import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitCommand, GitCommandError } from './git-command';

describe('GitCommand', () => {
  let dir: string;
  const git = new GitCommand();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wired-git-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs git and returns stdout', async () => {
    const output = await git.run(['--version'], { cwd: dir });
    expect(output.toString()).toMatch(/^git version 2\./);
  });

  it('reports a non-zero exit with stderr', async () => {
    await expect(
      git.run(['rev-parse', '--verify', 'missing-ref'], { cwd: dir }),
    ).rejects.toBeInstanceOf(GitCommandError);
  });
});
