import {
  PackageGitCommandServices,
  runPackageGitCommand,
} from './package-git-cli';

describe('runPackageGitCommand', () => {
  const services = (
    overrides: Partial<PackageGitCommandServices> = {},
  ): PackageGitCommandServices => ({
    migrate: jest.fn(async () => 1),
    cleanup: jest.fn(async () => 1),
    gc: jest.fn(async () => undefined),
    export: jest.fn(async () => 1),
    repair: jest.fn(async () => undefined),
    ...overrides,
  });

  it('keeps going when one package fails and reports the failure', async () => {
    const order: number[] = [];
    const log: string[] = [];
    const commandServices = services({
      migrate: jest.fn(async (packageId: number) => {
        order.push(packageId);
        if (packageId === 4) {
          throw new Error('legacy directory is missing');
        }
        return 2;
      }),
    });

    const failures = await runPackageGitCommand(
      'migrate',
      [4, 7],
      commandServices,
      (message) => log.push(message),
    );

    expect(failures).toBe(1);
    expect(order).toEqual([4, 7]);
    expect(log).toContain('package 4: failed — legacy directory is missing');
    expect(log).toContain('package 7: 2 revision(s) migrated');
  });

  it('reports zero failures when every package succeeds', async () => {
    const log: string[] = [];

    const failures = await runPackageGitCommand(
      'repair',
      [1, 2],
      services(),
      (message) => log.push(message),
    );

    expect(failures).toBe(0);
    expect(log).toEqual([
      'package 1: refs repaired',
      'package 2: refs repaired',
    ]);
  });
});
