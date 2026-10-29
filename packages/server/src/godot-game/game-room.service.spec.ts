import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { Room } from 'src/database/entities/room.entity';
import { User } from 'src/database/entities/user.entity';
import { RoomsService } from 'src/rooms/rooms.service';
import { GameRoomService } from './game-room.service';
import { GameRoomTicketRateLimiter } from './game-room.rate-limiter';
import { RoomRuntimeError } from './room-runtime.errors';
import { RoomRuntimeService } from './room-runtime.service';
import { RoomConnection, RoomRuntimeInfo } from './room-runtime.types';

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

describe('GameRoomService', () => {
  let rooms: { findOne: jest.Mock };
  let runtime: { getConnection: jest.Mock; getRuntime: jest.Mock };
  let service: GameRoomService;

  const create = (limit = 20) => {
    rooms = { findOne: jest.fn() };
    runtime = { getConnection: jest.fn(), getRuntime: jest.fn() };
    const configService = {
      godotRuntime: { ticketRateLimit: limit, ticketRateLimitWindowMs: 60_000 },
    } as unknown as AppConfigService;
    service = new GameRoomService(
      rooms as unknown as RoomsService,
      runtime as unknown as RoomRuntimeService,
      new GameRoomTicketRateLimiter(configService),
    );
    rooms.findOne.mockResolvedValue(room());
    runtime.getConnection.mockResolvedValue(connection());
  };

  beforeEach(() => {
    create();
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
    expect(runtime.getConnection).toHaveBeenCalledWith('42');
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
    expect(runtime.getConnection).toHaveBeenCalledTimes(2);
  });

  it('never issues a ticket to an anonymous caller', async () => {
    await expect(
      statusOf(service.connect(undefined as unknown as User, 42)),
    ).resolves.toBe(401);
    expect(runtime.getConnection).not.toHaveBeenCalled();
  });

  it('rejects rooms that are not Godot rooms before touching the runtime', async () => {
    rooms.findOne.mockResolvedValue(room({ type: 'ts-game' }));

    await expect(statusOf(service.connect(user(1), 42))).resolves.toBe(400);
    expect(runtime.getConnection).not.toHaveBeenCalled();
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
    expect(runtime.getConnection).toHaveBeenCalledTimes(2);
    await expect(service.connect(user(2), 42)).resolves.toBeDefined();
  });

  it('maps a runtime start failure to an explicit error without process internals', async () => {
    runtime.getConnection.mockRejectedValue(
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

  it('reports idle status without starting a runtime', async () => {
    runtime.getRuntime.mockReturnValue(null);

    await expect(service.getStatus(user(1), 42)).resolves.toEqual({
      roomId: 42,
      state: 'idle',
      endpoint: null,
      activePlayers: 0,
      error: null,
    });
    expect(runtime.getConnection).not.toHaveBeenCalled();
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
    expect(runtime.getConnection).not.toHaveBeenCalled();
  });

  it('applies the same access rules to the status endpoint', async () => {
    rooms.findOne.mockResolvedValue(room({ isPublic: false, author: user(1) }));

    await expect(statusOf(service.getStatus(user(3), 42))).resolves.toBe(403);
    expect(runtime.getRuntime).not.toHaveBeenCalled();
  });

  it('keeps exceptions that are not runtime lifecycle errors intact', async () => {
    rooms.findOne.mockRejectedValue(new BadRequestException('bad'));
    await expect(statusOf(service.connect(user(1), 42))).resolves.toBe(400);
    await expect(service.getStatus(user(1), 42)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('uses the same unauthorized and forbidden exception types as the API', async () => {
    await expect(
      service.getStatus(undefined as unknown as User, 42),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    rooms.findOne.mockResolvedValue(room({ isPublic: false, author: user(1) }));
    await expect(service.getStatus(user(2), 42)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
