import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppConfigService } from 'src/config/config.service';
import { GitCommand } from '../storage/git/git-command';
import { PackageGitRepository } from '../storage/git/package-git-repository';

// Windows: запуск git-процесса на нагруженной машине (jest в несколько
// воркеров) легко выходит за дефолтные 5 с, а прерванный тест оставляет
// процесс, который держит каталог и ломает cleanup.
jest.setTimeout(30_000);

export interface TestRepository {
  repo: PackageGitRepository;
  root: string;
  cleanup: () => void;
}

/**
 * Creates a throwaway storage root and a `PackageGitRepository` bound to it.
 * Tests clean up with `cleanup()` in `afterEach`.
 */
export function makeRepository(gitStorage = true): TestRepository {
  const root = mkdtempSync(join(tmpdir(), 'wired-git-'));
  const config = {
    storage: { dir: root, packagesFilesDir: root },
    packages: { gitStorage },
  } as unknown as AppConfigService;
  return {
    repo: new PackageGitRepository(config, new GitCommand()),
    root,
    // Windows: git может ещё держать handle на файлы репозитория после
    // завершения команды, поэтому удаление ретраится.
    cleanup: () =>
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
  };
}

export function writeLegacyFile(
  root: string,
  packageId: number,
  revision: number,
  filepath: string,
  content: string,
): string {
  const absolute = join(
    root,
    String(packageId),
    'revisions',
    String(revision),
    filepath,
  );
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}
