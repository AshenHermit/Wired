import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { PackageSyncService } from './package-sync.service';
import { RoomRuntimeService } from './room-runtime.service';

const flushAsync = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};

describe('PackageSyncService', () => {
  let packages: jest.Mocked<
    Pick<Repository<ScriptingPackage>, 'find' | 'findOne'>
  >;
  let revisions: jest.Mocked<
    Pick<Repository<ScriptingPackageRevision>, 'findOne'>
  >;
  let runtime: {
    sendPackage: jest.Mock;
    getRuntime: jest.Mock;
    setObserver: jest.Mock;
  };
  let service: PackageSyncService;

  const roomPackage = {
    id: 42,
    name: 'Demo package',
    room: { id: 7 },
  } as unknown as ScriptingPackage;

  beforeEach(() => {
    packages = {
      find: jest.fn().mockResolvedValue([roomPackage]),
      findOne: jest.fn().mockResolvedValue(roomPackage),
    };
    revisions = {
      findOne: jest.fn().mockResolvedValue({
        revision: 3,
        publishedAt: new Date('2026-10-30T09:00:00.000Z'),
      } as unknown as ScriptingPackageRevision),
    };
    runtime = {
      sendPackage: jest.fn().mockReturnValue(true),
      getRuntime: jest.fn().mockReturnValue({ state: 'running' }),
      setObserver: jest.fn(),
    };
    service = new PackageSyncService(
      packages as unknown as Repository<ScriptingPackage>,
      revisions as unknown as Repository<ScriptingPackageRevision>,
      runtime as unknown as RoomRuntimeService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
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
    revisions.findOne.mockResolvedValue({
      revision: 4,
      publishedAt: new Date('2026-10-30T10:00:00.000Z'),
    } as unknown as ScriptingPackageRevision);

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
    revisions.findOne.mockResolvedValue({
      revision: 4,
      publishedAt: new Date('2026-10-30T10:00:00.000Z'),
    } as unknown as ScriptingPackageRevision);

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
});
