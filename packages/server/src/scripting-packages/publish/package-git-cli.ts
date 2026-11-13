import { errorMessage } from 'src/common/errors';

export type PackageGitCommand =
  | 'migrate'
  | 'cleanup'
  | 'gc'
  | 'export'
  | 'repair';

/** Operations the `packages:git` CLI runs for every selected package. */
export interface PackageGitCommandServices {
  migrate(packageId: number): Promise<number>;
  cleanup(packageId: number): Promise<number>;
  gc(packageId: number): Promise<void>;
  export(packageId: number): Promise<number>;
  repair(packageId: number): Promise<void>;
}

export type PackageGitLog = (message: string) => void;

/**
 * Runs one git-storage command over the given packages, isolating failures:
 * one unconverted or broken package must not stop the rest of `--all`, so the
 * command finishes what it can and reports the number of failed packages.
 */
export async function runPackageGitCommand(
  command: PackageGitCommand,
  packageIds: readonly number[],
  services: PackageGitCommandServices,
  log: PackageGitLog,
): Promise<number> {
  let failures = 0;
  for (const packageId of packageIds) {
    try {
      switch (command) {
        case 'migrate': {
          const count = await services.migrate(packageId);
          log(`package ${packageId}: ${count} revision(s) migrated`);
          break;
        }
        case 'cleanup': {
          const count = await services.cleanup(packageId);
          log(`package ${packageId}: ${count} legacy director(ies) removed`);
          break;
        }
        case 'gc':
          await services.gc(packageId);
          log(`package ${packageId}: maintenance complete`);
          break;
        case 'export': {
          const count = await services.export(packageId);
          log(`package ${packageId}: ${count} revision(s) exported`);
          break;
        }
        case 'repair':
          await services.repair(packageId);
          log(`package ${packageId}: refs repaired`);
          break;
      }
    } catch (error) {
      failures += 1;
      log(`package ${packageId}: failed — ${errorMessage(error)}`);
    }
  }
  return failures;
}
