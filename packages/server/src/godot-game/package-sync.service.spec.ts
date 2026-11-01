import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { PackageDeliveryService } from 'src/scripting-packages/package-delivery.service';
import { PackageSyncService } from './package-sync.service';
import { RoomRuntimeService } from './room-runtime.service';
import { SyncRecordStore } from './sync-record-store';

const flushAsync = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};

describe('PackageSyncService', () => {
  let packages: jest.Mocked<
    Pick<Repository<ScriptingPackage>, 'find' | 'findOne'>
  >;
  let revisions: jest.Mocked<Pick<Repository<ScriptingPackageRevision>, 'find'>>;
  let published: Map<number, { revision: number; publishedAt: Date }>;
  let runtime: {
    sendPackage: jest.Mock;
    getRuntime: jest.Mock;
    setObserver: jest.Mock;
  };
  let delivery: { findDependentRoomPackages: jest.Mock };
  let service: PackageSyncService;

  const roomPackage = {
    id: 42,
    name: 'Demo package',
    room: { id: 7 },
  } as unknown as ScriptingPackage;

  /** Latest published revision per package, as the batched query would return. */
  const publishRevision = (
    packageId: number,
    revision: number,
    publishedAt = new Date('2026-10-30T09:00:00.000Z'),
  ): void => {
    published.set(packageId, { revision, publishedAt });
  };

  beforeEach(() => {
    packages = {
      find: jest.fn().mockResolvedValue([roomPackage]),
      findOne: jest.fn().mockResolvedValue(roomPackage),
    };
    published = new Map();
    publishRevision(42, 3);
    revisions = {
      find: jest.fn(async () =>
        [...published.entries()]
          .sort(([, a], [, b]) => b.revision - a.revision)
          .map(([packageId, entry]) => ({
            package: { id: packageId },
            ...entry,
          })) as unknown as ScriptingPackageRevision[],
      ),
    };
    runtime = {
      sendPackage: jest.fn().mockReturnValue(true),
      getRuntime: jest.fn().mockReturnValue({ state: 'running' }),
      setObserver: jest.fn(),
    };
    delivery = {
      findDependentRoomPackages: jest.fn().mockResolvedValue([]),
    };
    service = new PackageSyncService(
      packages as unknown as Repository<ScriptingPackage>,
      revisions as unknown as Repository<ScriptingPackageRevision>,
      runtime as unknown as RoomRuntimeService,
      delivery as unknown as PackageDeliveryService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('dispatches a published revision to the package room runtime', async () => {
    await service.revisionPublished(42, 3);

    expect(runtime.sendPackage).toHaveBeenCalledWith('7', 42, 3);
    expect(runtime.sendPackage).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast a package without a room', async () => {
    packages.findOne.mockResolvedValue({
      id: 42,
      name: 'Shared',
      room: null,
    } as unknown as ScriptingPackage);

    await service.revisionPublished(42, 3);

    expect(runtime.sendPackage).not.toHaveBeenCalled();
  });

  it('does not resend the same room/package/revision', async () => {
    await service.revisionPublished(42, 3);
    await service.revisionPublished(42, 3);

    expect(runtime.sendPackage).toHaveBeenCalledTimes(1);
  });

  it('re-dispatches dependent room packages when a library publishes', async () => {
    delivery.findDependentRoomPackages.mockResolvedValue([
      { packageId: 99, roomId: 7, revision: 4 },
    ]);

    await service.revisionPublished(42, 3);

    expect(runtime.sendPackage).toHaveBeenCalledWith('7', 42, 3);
    expect(runtime.sendPackage).toHaveBeenCalledWith('7', 99, 4);
  });

  it('re-dispatches room dependents of a global library', async () => {
    packages.findOne.mockResolvedValue({
      id: 42,
      name: 'Shared',
      room: null,
    } as unknown as ScriptingPackage);
    delivery.findDependentRoomPackages.mockResolvedValue([
      { packageId: 99, roomId: 7, revision: 4 },
    ]);

    await service.revisionPublished(42, 3);

    expect(delivery.findDependentRoomPackages).toHaveBeenCalledWith(42);
    expect(runtime.sendPackage).toHaveBeenCalledTimes(1);
    expect(runtime.sendPackage).toHaveBeenCalledWith('7', 99, 4);
  });

  it('reports a dependent with its actual latest published revision', async () => {
    delivery.findDependentRoomPackages.mockResolvedValue([
      { packageId: 99, roomId: 7, revision: 4 },
    ]);
    packages.find.mockResolvedValue([
      { id: 99, name: 'Game' },
    ] as unknown as ScriptingPackage[]);
    publishRevision(99, 4, new Date('2026-10-30T10:00:00.000Z'));

    await service.revisionPublished(42, 3);

    expect((await service.getStatuses('7'))[0]).toMatchObject({
      packageId: 99,
      revision: 4,
      publishedAt: '2026-10-30T10:00:00.000Z',
      // Record-derived: without the dependent record the aggregate state would
      // still be 'published', because the dispatch would not be tracked.
      state: 'pending',
      runtime: { state: 'pending', revision: 4 },
    });
  });

  it('keeps a dependent pending until a runtime is ready', async () => {
    runtime.getRuntime.mockReturnValue({ state: 'starting' });
    packages.find.mockResolvedValue([
      { id: 99, name: 'Game' },
    ] as unknown as ScriptingPackage[]);
    publishRevision(99, 4);
    delivery.findDependentRoomPackages.mockResolvedValue([
      { packageId: 99, roomId: 7, revision: 4 },
    ]);

    await service.revisionPublished(42, 3);

    expect(runtime.sendPackage).not.toHaveBeenCalled();
    const pending = await service.getStatuses('7');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      packageId: 99,
      revision: 4,
      state: 'published',
      runtime: { state: 'pending', revision: 4 },
    });
    // The status above looks the same with or without a record, so read the
    // in-memory record itself to prove the publish created it.
    const store = (service as unknown as { store: SyncRecordStore }).store;
    expect(store.get('7', 99)).toMatchObject({
      revision: 4,
      runtimeState: 'pending',
      dispatchedAt: null,
    });

    runtime.getRuntime.mockReturnValue({ state: 'running' });
    service.onModuleInit();

    service.onRuntimeReady('7');
    await flushAsync();

    expect(runtime.sendPackage).toHaveBeenCalledTimes(1);
    expect(runtime.sendPackage).toHaveBeenCalledWith('7', 99, 4);
  });

  it('refreshes dependents on a repeated library publish without resending it', async () => {
    delivery.findDependentRoomPackages.mockResolvedValue([
      { packageId: 99, roomId: 7, revision: 4 },
    ]);
    await service.revisionPublished(42, 3);
    service.onPackagesApplied('7', 99, 4, 1);
    expect(runtime.sendPackage).toHaveBeenCalledTimes(2);

    await service.revisionPublished(42, 3);

    expect(runtime.sendPackage).toHaveBeenCalledTimes(3);
    expect(runtime.sendPackage).toHaveBeenLastCalledWith('7', 99, 4);
  });

  it('logs a dependent scan failure and still publishes', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    delivery.findDependentRoomPackages.mockRejectedValue(
      new Error('scan failed'),
    );

    await expect(service.revisionPublished(42, 3)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to scan dependents of package 42'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('scan failed'),
    );
    expect(runtime.sendPackage).toHaveBeenCalledWith('7', 42, 3);
  });

  it('upgrades a dependent to a newer scanned revision', async () => {
    packages.find.mockResolvedValue([
      { id: 99, name: 'Game' },
    ] as unknown as ScriptingPackage[]);
    delivery.findDependentRoomPackages
      .mockResolvedValueOnce([{ packageId: 99, roomId: 7, revision: 4 }])
      .mockResolvedValueOnce([{ packageId: 99, roomId: 7, revision: 5 }]);

    await service.revisionPublished(42, 3);
    expect(runtime.sendPackage).toHaveBeenLastCalledWith('7', 99, 4);

    publishRevision(99, 5, new Date('2026-10-30T10:00:00.000Z'));

    await service.revisionPublished(42, 3);

    expect(runtime.sendPackage).toHaveBeenLastCalledWith('7', 99, 5);
    const status = (await service.getStatuses('7'))[0];
    expect(status).toMatchObject({
      packageId: 99,
      revision: 5,
      publishedAt: '2026-10-30T10:00:00.000Z',
      runtime: { state: 'pending', revision: 5 },
    });
    expect(status.state).not.toBe('stale');
  });

  it('retries a dependent that exhausted its attempts when a library publishes', async () => {
    jest.useFakeTimers();
    packages.find.mockResolvedValue([
      { id: 99, name: 'Game' },
    ] as unknown as ScriptingPackage[]);
    publishRevision(99, 4);
    delivery.findDependentRoomPackages.mockResolvedValue([
      { packageId: 99, roomId: 7, revision: 4 },
    ]);

    await service.revisionPublished(42, 3);
    service.onPackagesApplied('7', 42, 3, 1);
    service.onModuleInit();
    expect(runtime.sendPackage).toHaveBeenCalledTimes(2);

    // Exhaust the dependent's attempts: two retries, then no `nextAttemptAt`,
    // so only a fresh refresh can send it again.
    service.onPackagesFailed('7', 99, 4, 'hash mismatch');
    jest.advanceTimersByTime(10_000);
    await flushAsync();
    service.onPackagesFailed('7', 99, 4, 'hash mismatch');
    jest.advanceTimersByTime(20_000);
    await flushAsync();
    service.onPackagesFailed('7', 99, 4, 'hash mismatch');
    jest.advanceTimersByTime(120_000);
    await flushAsync();

    expect(runtime.sendPackage).toHaveBeenCalledTimes(4);
    expect((await service.getStatuses('7'))[0]).toMatchObject({
      packageId: 99,
      state: 'failed',
      runtime: { state: 'failed' },
    });

    await service.revisionPublished(42, 3);

    expect(runtime.sendPackage).toHaveBeenCalledTimes(5);
    expect(runtime.sendPackage).toHaveBeenLastCalledWith('7', 99, 4);
    expect((await service.getStatuses('7'))[0]).toMatchObject({
      packageId: 99,
      state: 'pending',
      runtime: { state: 'pending', error: null },
    });
  });

  it('leaves the revision pending while the runtime is not running', async () => {
    runtime.getRuntime.mockReturnValue({ state: 'starting' });

    await service.revisionPublished(42, 3);

    expect(runtime.sendPackage).not.toHaveBeenCalled();
    const statuses = await service.getStatuses('7');
    expect(statuses[0]).toMatchObject({
      packageId: 42,
      revision: 3,
      state: 'published',
      runtime: { state: 'pending' },
    });
  });

  it('reports applied server state and pending clients separately', async () => {
    await service.revisionPublished(42, 3);
    service.onPackagesApplied('7', 42, 3, 2);
    service.onPeerAuthenticated('7', 5);

    const statuses = await service.getStatuses('7');

    expect(statuses[0]).toMatchObject({
      packageId: 42,
      revision: 3,
      state: 'applied',
      runtime: { state: 'applied', revision: 3, error: null },
    });
    expect(statuses[0].clients).toEqual([
      expect.objectContaining({ peer: 5, state: 'pending', revision: 3 }),
    ]);
  });

  it('becomes ready only when every authenticated client reports readiness', async () => {
    await service.revisionPublished(42, 3);
    service.onPackagesApplied('7', 42, 3, 2);
    service.onPeerAuthenticated('7', 5);
    service.onPeerAuthenticated('7', 6);
    service.onClientPackagesReady('7', 5, 42, 3);

    expect((await service.getStatuses('7'))[0].state).toBe('applied');

    service.onClientPackagesReady('7', 6, 42, 3);

    expect((await service.getStatuses('7'))[0].state).toBe('ready');
  });

  it('exposes a client download failure without hiding it', async () => {
    await service.revisionPublished(42, 3);
    service.onPackagesApplied('7', 42, 3, 2);
    service.onPeerAuthenticated('7', 5);
    service.onClientPackagesFailed('7', 5, 42, 3, 'download failed');

    const status = (await service.getStatuses('7'))[0];

    expect(status.state).toBe('failed');
    expect(status.clients[0]).toMatchObject({
      peer: 5,
      state: 'failed',
      error: 'download failed',
    });
  });

  it('retries a failed runtime application with backoff and then stops', async () => {
    jest.useFakeTimers();
    await service.revisionPublished(42, 3);
    service.onModuleInit();

    service.onPackagesFailed('7', 42, 3, 'hash mismatch');
    jest.advanceTimersByTime(10_000);
    await flushAsync();
    expect(runtime.sendPackage).toHaveBeenCalledTimes(2);

    service.onPackagesFailed('7', 42, 3, 'hash mismatch');
    jest.advanceTimersByTime(20_000);
    await flushAsync();
    expect(runtime.sendPackage).toHaveBeenCalledTimes(3);

    service.onPackagesFailed('7', 42, 3, 'hash mismatch');
    jest.advanceTimersByTime(120_000);
    await flushAsync();
    expect(runtime.sendPackage).toHaveBeenCalledTimes(3);
    expect((await service.getStatuses('7'))[0].state).toBe('failed');
  });

  it('marks a record stale when a newer published revision exists', async () => {
    await service.revisionPublished(42, 3);
    publishRevision(42, 4, new Date('2026-10-30T10:00:00.000Z'));

    const status = (await service.getStatuses('7'))[0];

    expect(status).toMatchObject({ revision: 4, state: 'stale' });
  });

  it('reconciles the latest manifest when the runtime becomes ready', async () => {
    service.onModuleInit();
    service.onRuntimeReady('7');

    await flushAsync();

    expect(packages.find).toHaveBeenCalled();
    expect(runtime.sendPackage).toHaveBeenCalledWith('7', 42, 3);
  });

  it('does not apply a confirmation for an obsolete revision', async () => {
    await service.revisionPublished(42, 3);
    service.onPackagesApplied('7', 42, 2, 1);

    const status = (await service.getStatuses('7'))[0];

    expect(status.runtime.state).toBe('pending');
    expect(status.state).toBe('pending');
  });

  it('adopts a newer revision that the runtime confirmed', async () => {
    await service.revisionPublished(42, 3);
    publishRevision(42, 4, new Date('2026-10-30T10:00:00.000Z'));

    service.onPackagesApplied('7', 42, 4, 2);

    const status = (await service.getStatuses('7'))[0];
    expect(status).toMatchObject({
      revision: 4,
      state: 'applied',
      runtime: { state: 'applied', revision: 4 },
    });
  });

  it('registers itself as the runtime observer', () => {
    service.onModuleInit();

    expect(runtime.setObserver).toHaveBeenCalledWith(service);

    service.onModuleDestroy();

    expect(runtime.setObserver).toHaveBeenLastCalledWith(undefined);
  });

  it('resends applied revisions to a fresh runtime process', async () => {
    await service.revisionPublished(42, 3);
    service.onPackagesApplied('7', 42, 3, 2);
    service.onPeerAuthenticated('7', 5);

    service.onRuntimeReady('7');
    await flushAsync();

    expect(runtime.sendPackage).toHaveBeenCalledTimes(2);
    const status = (await service.getStatuses('7'))[0];
    expect(status.runtime.state).toBe('pending');
    expect(status.clients).toEqual([]);
  });

  it('derives status for a room-filtered package without loading the room relation', async () => {
    await service.revisionPublished(42, 3);
    packages.find.mockResolvedValue([
      { id: 42, name: 'Demo package' },
    ] as unknown as ScriptingPackage[]);

    const status = (await service.getStatuses('7'))[0];

    expect(status).toMatchObject({
      packageId: 42,
      revision: 3,
      runtime: { state: 'pending', revision: 3 },
    });
  });

  it('retries a dispatch that the runtime never confirms', async () => {
    jest.useFakeTimers();
    await service.revisionPublished(42, 3);
    service.onModuleInit();

    jest.advanceTimersByTime(30_000);
    await flushAsync();
    expect(runtime.sendPackage).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(30_000);
    await flushAsync();
    expect(runtime.sendPackage).toHaveBeenCalledTimes(3);

    jest.advanceTimersByTime(120_000);
    await flushAsync();
    expect(runtime.sendPackage).toHaveBeenCalledTimes(3);
    const status = (await service.getStatuses('7'))[0];
    expect(status.runtime).toMatchObject({
      state: 'failed',
      error: 'runtime did not confirm the revision in time',
    });
  });

  it('forgets failures of peers that already left', async () => {
    await service.revisionPublished(42, 3);
    service.onPackagesApplied('7', 42, 3, 1);
    service.onPeerAuthenticated('7', 5);
    service.onClientPackagesFailed('7', 5, 42, 3, 'download failed');
    expect((await service.getStatuses('7'))[0].state).toBe('failed');

    service.onPeerLeft('7', 5);

    expect((await service.getStatuses('7'))[0].state).toBe('applied');
  });

  it('does not wait for peers of a previous runtime after it restarts', async () => {
    await service.revisionPublished(42, 3);
    service.onPackagesApplied('7', 42, 3, 1);
    // Peer 5 belongs to the first process; it never sends `player_left` when
    // the process dies, so the backend learns about the restart only from the
    // next `ready` line.
    service.onPeerAuthenticated('7', 5);
    expect((await service.getStatuses('7'))[0].state).toBe('applied');

    service.onRuntimeReady('7');
    await flushAsync();
    service.onPackagesApplied('7', 42, 3, 1);

    // A new player joins the restarted runtime and is fully ready.
    service.onPeerAuthenticated('7', 6);
    service.onClientPackagesReady('7', 6, 42, 3);

    const [status] = await service.getStatuses('7');
    expect(status.state).toBe('ready');
    expect(status.clients.map((client) => client.peer)).toEqual([6]);
  });

  it('loads the latest published revisions of every room package in one query', async () => {
    packages.find.mockResolvedValue([
      { id: 42, name: 'Demo package' },
      { id: 43, name: 'Second package' },
      { id: 44, name: 'Third package' },
    ] as unknown as ScriptingPackage[]);
    publishRevision(42, 7);
    publishRevision(43, 2);
    publishRevision(44, 11);

    const statuses = await service.getStatuses('7');

    expect(revisions.find).toHaveBeenCalledTimes(1);
    expect(revisions.find.mock.calls[0][0]).toMatchObject({
      where: { package: { id: expect.anything() }, status: 'published' },
      order: { revision: 'DESC' },
    });
    expect(statuses.map((status) => [status.packageId, status.revision])).toEqual(
      [
        [42, 7],
        [43, 2],
        [44, 11],
      ],
    );
  });

  it('does not query revisions when the room has no packages', async () => {
    packages.find.mockResolvedValue([] as unknown as ScriptingPackage[]);

    await expect(service.getStatuses('7')).resolves.toEqual([]);
    expect(revisions.find).not.toHaveBeenCalled();
  });

  it('reconciles every room package through a single revision query', async () => {
    packages.find.mockResolvedValue([
      { id: 42, name: 'Demo package' },
      { id: 43, name: 'Second package' },
    ] as unknown as ScriptingPackage[]);
    publishRevision(42, 3);
    publishRevision(43, 2);

    await service.reconcileRoom('7');

    expect(revisions.find).toHaveBeenCalledTimes(1);
    expect(runtime.sendPackage).toHaveBeenCalledTimes(2);
    expect(runtime.sendPackage).toHaveBeenCalledWith('7', 42, 3);
    expect(runtime.sendPackage).toHaveBeenCalledWith('7', 43, 2);
  });
});
