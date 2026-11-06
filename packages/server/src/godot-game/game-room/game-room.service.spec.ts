import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { PackageSyncStatus } from '@wired-io/shared';
import { AppConfigService } from 'src/config/config.service';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { RoomsService } from 'src/rooms/rooms.service';
import { GameRoomService } from './game-room.service';
import {
  GameRoomTicketRateLimiter,
  InMemoryTicketRateLimitStore,
} from './game-room.rate-limiter';
import { RoomRuntimeError } from '../runtime/room-runtime.errors';
import { RoomRuntimeService } from '../runtime/room-runtime.service';
import { PackageSyncService } from '../package-sync/package-sync.service';
import { RoomConnection, RoomRuntimeInfo } from '../runtime/room-runtime.types';

const user = (id: number): User => ({ id, email: `u${id}@wired.io` }) as User;

const room = (overrides: Partial<Room> = {}): Room =>
  ({
    id: 42,
    name: 'Room',
    type: 'godot',
    isPublic: true,
    description: '',
    parentRoomId: null,
    contributors: [],
    ...overrides,
  }) as Room;

const runtimeInfo = (
  overrides: Partial<RoomRuntimeInfo> = {},
): RoomRuntimeInfo => ({
  key: '42:19100',
  roomId: '42',
  port: 19100,
  pid: 1234,
  state: 'running',
  endpoint: 'ws://127.0.0.1:19100',
  startedAt: '2026-01-01T00:00:00.000Z',
  stoppedAt: null,
  activePlayers: 2,
  exitCode: null,
  error: null,
  ...overrides,
});

const connection = (): RoomConnection => ({
  ...runtimeInfo(),
  ticket: 'ticket-value',
  ticketExpiresAt: 1_800_000_000,
});

type StatusOverrides = Omit<
  Partial<PackageSyncStatus>,
  'runtime' | 'clients' | 'slug'
> & {
  runtime?: Partial<PackageSyncStatus['runtime']>;
  clients?: PackageSyncStatus['clients'];
};

const status = (overrides: StatusOverrides = {}): PackageSyncStatus => {
  const { runtime, clients, ...rest } = overrides;
  return {
    packageId: 3,
    slug: 'demo',
    name: 'Demo',
    enabled: true,
    revision: 2,
    publishedAt: '2026-10-30T09:00:00.000Z',
    state: 'applied',
    runtime: {
      state: 'applied',
      revision: 2,
      error: null,
      updatedAt: '2026-10-30T09:01:00.000Z',
      ...runtime,
    },
    clients: clients ?? [],
    ...rest,
  };
};

describe('GameRoomService', () => {
  let rooms: { findOne: jest.Mock };
  let runtime: {
    connectRoom: jest.Mock;
    stopRoom: jest.Mock;
    getRuntime: jest.Mock;
  };
  let packageSync: { getStatuses: jest.Mock };
  let service: GameRoomService;

  const create = (limit = 20) => {
    rooms = { findOne: jest.fn() };
    runtime = {
      connectRoom: jest.fn(),
      stopRoom: jest.fn(),
      getRuntime: jest.fn(),
    };
    packageSync = { getStatuses: jest.fn(async () => []) };
    const configService = {
      godotRuntime: { ticketRateLimit: limit, ticketRateLimitWindowMs: 60_000 },
    } as unknown as AppConfigService;
    service = new GameRoomService(
      rooms as unknown as RoomsService,
      runtime as unknown as RoomRuntimeService,
      new GameRoomTicketRateLimiter(
        configService,
        new InMemoryTicketRateLimitStore(),
      ),
      packageSync as unknown as PackageSyncService,
    );
    rooms.findOne.mockResolvedValue(room());
    runtime.connectRoom.mockResolvedValue(connection());
  };

  beforeEach(() => {
    create();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const statusOf = async (promise: Promise<unknown>): Promise<number> => {
    try {
      await promise;
    } catch (error) {
      return error instanceof HttpException ? error.getStatus() : -1;
    }
    throw new Error('Expected the call to reject');
  };

  it('issues a one-time ticket for an authenticated user of a public Godot room', async () => {
    const result = await service.connect(user(7), 42);

    expect(rooms.findOne).toHaveBeenCalledWith(42);
    expect(runtime.connectRoom).toHaveBeenCalledWith('42');
    expect(result).toEqual({
      roomId: 42,
      endpoint: 'ws://127.0.0.1:19100',
      ticket: 'ticket-value',
      ticketExpiresAt: 1_800_000_000,
      activePlayers: 2,
    });
    expect(JSON.stringify(result)).not.toMatch(/pid|"port"|"key"/);
  });

  it('lets only the author or a contributor join a private room', async () => {
    rooms.findOne.mockResolvedValue(
      room({
        isPublic: false,
        author: user(1),
        contributors: [user(2)],
      }),
    );

    await expect(service.connect(user(1), 42)).resolves.toMatchObject({
      roomId: 42,
    });
    await expect(service.connect(user(2), 42)).resolves.toMatchObject({
      roomId: 42,
    });
    await expect(statusOf(service.connect(user(3), 42))).resolves.toBe(403);
    expect(runtime.connectRoom).toHaveBeenCalledTimes(2);
  });

  it('rejects rooms that are not Godot rooms before touching the runtime', async () => {
    rooms.findOne.mockResolvedValue(room({ type: 'ts-game' }));

    await expect(statusOf(service.connect(user(1), 42))).resolves.toBe(400);
    expect(runtime.connectRoom).not.toHaveBeenCalled();
  });

  it('propagates a missing room as 404', async () => {
    rooms.findOne.mockRejectedValue(new NotFoundException('Room not found'));

    await expect(statusOf(service.connect(user(1), 42))).resolves.toBe(404);
  });

  it('rate limits repeated joins per user and room before starting Godot', async () => {
    create(2);

    await service.connect(user(1), 42);
    await service.connect(user(1), 42);
    const blocked = service.connect(user(1), 42);

    await expect(statusOf(blocked)).resolves.toBe(429);
    expect(runtime.connectRoom).toHaveBeenCalledTimes(2);
    await expect(service.connect(user(2), 42)).resolves.toBeDefined();
  });

  it('maps a runtime start failure to an explicit error without process internals', async () => {
    runtime.connectRoom.mockRejectedValue(
      new RoomRuntimeError(
        'start_failed',
        'Godot runtime exited with code 3: port 19100 is already in use',
        '42',
        19100,
      ),
    );

    const error = await service.connect(user(1), 42).catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(502);
    expect(JSON.stringify(error.getResponse())).not.toMatch(/19100|pid|key/);
    expect(error.getResponse()).toMatchObject({ code: 'start_failed' });
  });

  it('returns a ticket immediately when the room has no packages', async () => {
    packageSync.getStatuses.mockResolvedValue([]);
    const result = await service.connect(user(1), 42);
    expect(result.ticket).toBe('ticket-value');
  });

  it('waits until the runtime applied every package', async () => {
    packageSync.getStatuses
      .mockResolvedValueOnce([status({ runtime: { state: 'pending' } })])
      .mockResolvedValueOnce([status({ runtime: { state: 'applied' } })]);

    const result = await service.connect(user(1), 42);

    expect(result.ticket).toBe('ticket-value');
    expect(packageSync.getStatuses).toHaveBeenCalledTimes(2);
  });

  it('mints exactly one ticket per connection while the readiness wait runs', async () => {
    packageSync.getStatuses
      .mockResolvedValueOnce([status({ runtime: { state: 'pending' } })])
      .mockResolvedValueOnce([status({ runtime: { state: 'applied' } })]);

    const result = await service.connect(user(1), 42);

    expect(runtime.connectRoom).toHaveBeenCalledTimes(1);
    expect(runtime.stopRoom).not.toHaveBeenCalled();
    expect(result.ticket).toBe('ticket-value');
    expect(result.ticketExpiresAt).toBe(1_800_000_000);
  });

  it('does not mint another ticket when the readiness wait times out', async () => {
    jest.useFakeTimers();
    packageSync.getStatuses.mockResolvedValue([
      status({ runtime: { state: 'pending' } }),
    ]);

    const promise = service.connect(user(1), 42);
    const rejection = expect(promise).rejects.toMatchObject({ status: 409 });
    await jest.advanceTimersByTimeAsync(10_100);
    await rejection;

    expect(runtime.connectRoom).toHaveBeenCalledTimes(1);
  });

  it('does not wait for clients', async () => {
    packageSync.getStatuses.mockResolvedValue([
      status({ runtime: { state: 'applied' }, clients: [] }),
    ]);

    await expect(service.connect(user(1), 42)).resolves.toMatchObject({
      ticket: 'ticket-value',
    });
  });

  it('does not wait for disabled or unpublished room packages', async () => {
    jest.useFakeTimers();
    packageSync.getStatuses.mockResolvedValue([
      status({
        packageId: 1,
        enabled: false,
        revision: 0,
        publishedAt: null,
        runtime: { state: 'pending', revision: 0 },
      }),
      status({
        packageId: 2,
        enabled: true,
        revision: 0,
        publishedAt: null,
        runtime: { state: 'pending', revision: 0 },
      }),
      status({
        packageId: 3,
        enabled: true,
        revision: 4,
        runtime: { state: 'applied', revision: 4 },
      }),
    ]);

    const promise = service.connect(user(1), 42);
    await jest.advanceTimersByTimeAsync(10_100);

    await expect(promise).resolves.toMatchObject({ ticket: 'ticket-value' });
  });

  it('rejects with packages_pending after the timeout', async () => {
    jest.useFakeTimers();
    packageSync.getStatuses.mockResolvedValue([
      status({ runtime: { state: 'pending' } }),
    ]);

    const promise = service.connect(user(1), 42);
    const rejection = expect(promise).rejects.toMatchObject({ status: 409 });
    await jest.advanceTimersByTimeAsync(10_100);

    await rejection;
    expect(packageSync.getStatuses).toHaveBeenCalled();
  });

  it('rejects with packages_failed when the runtime failed a package', async () => {
    packageSync.getStatuses.mockResolvedValue([
      status({ runtime: { state: 'failed' } }),
    ]);

    await expect(service.connect(user(1), 42)).rejects.toMatchObject({
      status: 502,
    });
  });

  it('reports idle status without starting a runtime', async () => {
    runtime.getRuntime.mockReturnValue(null);

    await expect(service.getStatus(user(1), 42)).resolves.toEqual({
      roomId: 42,
      state: 'idle',
      endpoint: null,
      activePlayers: 0,
      error: null,
    });
    expect(runtime.connectRoom).not.toHaveBeenCalled();
  });

  it('reports the live runtime status and confirmed player count', async () => {
    runtime.getRuntime.mockReturnValue(runtimeInfo());

    await expect(service.getStatus(user(1), 42)).resolves.toEqual({
      roomId: 42,
      state: 'running',
      endpoint: 'ws://127.0.0.1:19100',
      activePlayers: 2,
      error: null,
    });
    expect(runtime.getRuntime).toHaveBeenCalledWith('42');
    expect(runtime.connectRoom).not.toHaveBeenCalled();
  });

  it('applies the same access rules to the status endpoint', async () => {
    rooms.findOne.mockResolvedValue(room({ isPublic: false, author: user(1) }));

    await expect(statusOf(service.getStatus(user(3), 42))).resolves.toBe(403);
    expect(runtime.getRuntime).not.toHaveBeenCalled();
  });

  it('reports package sync states for an allowed room', async () => {
    packageSync.getStatuses.mockResolvedValue([
      {
        packageId: 3,
        name: 'Demo',
        revision: 2,
        publishedAt: '2026-10-30T09:00:00.000Z',
        state: 'applied',
        runtime: {
          state: 'applied',
          revision: 2,
          error: null,
          updatedAt: '2026-10-30T09:01:00.000Z',
        },
        clients: [],
      },
    ]);

    await expect(service.getPackages(user(1), 42)).resolves.toMatchObject({
      roomId: 42,
      packages: [{ packageId: 3, state: 'applied' }],
    });
    expect(packageSync.getStatuses).toHaveBeenCalledWith('42');
    expect(runtime.connectRoom).not.toHaveBeenCalled();
  });

  it('applies the same access rules to package status', async () => {
    rooms.findOne.mockResolvedValue(room({ isPublic: false, author: user(1) }));

    await expect(statusOf(service.getPackages(user(3), 42))).resolves.toBe(403);
    expect(packageSync.getStatuses).not.toHaveBeenCalled();
  });

  it('keeps exceptions that are not runtime lifecycle errors intact', async () => {
    rooms.findOne.mockRejectedValue(new BadRequestException('bad'));
    await expect(statusOf(service.connect(user(1), 42))).resolves.toBe(400);
    await expect(service.getStatus(user(1), 42)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-member with the same forbidden exception type as the API', async () => {
    rooms.findOne.mockResolvedValue(room({ isPublic: false, author: user(1) }));
    await expect(service.getStatus(user(2), 42)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
