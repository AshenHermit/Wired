import type { DataSource } from 'typeorm';
import { PackagePublishLockService } from './package-publish-lock.service';

type QueryCall = [string, unknown[]?];

function makeDataSource(handler: (sql: string) => unknown): {
  dataSource: DataSource;
  query: jest.Mock;
  release: jest.Mock;
} {
  const query = jest.fn(async (sql: string) => handler(sql));
  const release = jest.fn(async () => undefined);
  const runner = {
    connect: jest.fn(async () => undefined),
    query,
    release,
  };
  const dataSource = {
    createQueryRunner: () => runner,
  } as unknown as DataSource;
  return { dataSource, query, release };
}

function lockCalls(query: jest.Mock): QueryCall[] {
  return query.mock.calls as QueryCall[];
}

describe('PackagePublishLockService', () => {
  it('marks every package as publishing while the callback runs', async () => {
    const service = new PackagePublishLockService();
    await service.runWithPublishLocks([4, 2, 4], async () => {
      await expect(service.assertNotPublishing(2)).rejects.toThrow(
        /being published/,
      );
      await expect(service.assertNotPublishing(4)).rejects.toThrow(
        /being published/,
      );
    });
    await expect(service.assertNotPublishing(2)).resolves.toBeUndefined();
  });

  it('releases the in-process guard when the callback throws', async () => {
    const service = new PackagePublishLockService();
    await expect(
      service.runWithPublishLocks([1], async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(service.assertNotPublishing(1)).resolves.toBeUndefined();
  });

  it('takes advisory locks in ascending id order', async () => {
    const { dataSource, query } = makeDataSource(() => [{ locked: true }]);
    const service = new PackagePublishLockService(dataSource);
    await service.runWithPublishLocks([9, 4], async () => undefined);
    expect(lockCalls(query).map(([, params]) => params?.[0])).toEqual([
      'wired.package-publish:4',
      'wired.package-publish:9',
      'wired.package-publish:9',
      'wired.package-publish:4',
    ]);
  });

  it('fails when another instance holds the publish lock', async () => {
    const { dataSource, query, release } = makeDataSource(() => [
      { locked: false },
    ]);
    const service = new PackagePublishLockService(dataSource);
    await expect(
      service.runWithPublishLocks([1], async () => undefined),
    ).rejects.toThrow(/being published/);
    expect(query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalled();
  });
});
