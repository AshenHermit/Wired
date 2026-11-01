import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { Room } from 'src/database/entities/room.entity';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { RoomMembershipGuard } from './room-membership.guard';

type RequestFixture = {
  user?: { id: number } | null;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
};

function executionContext(request: RequestFixture): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RoomMembershipGuard', () => {
  const room = {
    id: 7,
    isPublic: false,
    author: { id: 42 },
    contributors: [{ id: 43 }],
  };
  const pkg = { id: 5, room: { id: room.id } };

  let rooms: { findOne: jest.Mock };
  let packages: { findOne: jest.Mock };
  let guard: RoomMembershipGuard;

  beforeEach(() => {
    rooms = {
      findOne: jest.fn((options: { where: { id: number } }) =>
        Promise.resolve(options.where.id === room.id ? room : null),
      ),
    };
    packages = {
      findOne: jest.fn((options: { where: { id: number } }) =>
        Promise.resolve(options.where.id === pkg.id ? pkg : null),
      ),
    };
    guard = new RoomMembershipGuard(
      rooms as unknown as Repository<Room>,
      packages as unknown as Repository<ScriptingPackage>,
    );
  });

  const contextFor = (
    user: { id: number } | null,
    roomId: unknown = '7',
    packageId: unknown = '5',
  ) =>
    executionContext({
      user,
      query: { room: roomId },
      params: { id: packageId },
    });

  it('allows the room author', async () => {
    await expect(guard.canActivate(contextFor({ id: 42 }))).resolves.toBe(true);
    expect(rooms.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } }),
    );
    expect(packages.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5 } }),
    );
  });

  it('allows a room contributor', async () => {
    await expect(guard.canActivate(contextFor({ id: 43 }))).resolves.toBe(true);
  });

  it('rejects an authenticated non-member', async () => {
    await expect(guard.canActivate(contextFor({ id: 99 }))).rejects.toThrow(
      ForbiddenException,
    );
    expect(packages.findOne).not.toHaveBeenCalled();
  });

  it('rejects a package that belongs to another room', async () => {
    packages.findOne.mockResolvedValueOnce({ id: pkg.id, room: { id: 8 } });

    await expect(guard.canActivate(contextFor({ id: 42 }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a global package without a room', async () => {
    packages.findOne.mockResolvedValueOnce({ id: pkg.id, room: null });

    await expect(guard.canActivate(contextFor({ id: 42 }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects an unknown package', async () => {
    await expect(
      guard.canActivate(contextFor({ id: 42 }, '7', '404')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an unknown room', async () => {
    await expect(
      guard.canActivate(contextFor({ id: 42 }, '404')),
    ).rejects.toThrow(ForbiddenException);
    expect(packages.findOne).not.toHaveBeenCalled();
  });

  it('rejects an anonymous caller', async () => {
    await expect(guard.canActivate(contextFor(null))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(rooms.findOne).not.toHaveBeenCalled();
  });

  it.each([['7abc'], [''], ['-7'], [null], [0]])(
    'rejects the malformed room id %p',
    async (roomId) => {
      await expect(
        guard.canActivate(contextFor({ id: 42 }, roomId)),
      ).rejects.toThrow(ForbiddenException);
      expect(rooms.findOne).not.toHaveBeenCalled();
    },
  );

  it('rejects a request without a room query parameter', async () => {
    await expect(
      guard.canActivate(
        executionContext({ user: { id: 42 }, params: { id: '5' } }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(rooms.findOne).not.toHaveBeenCalled();
  });

  it('rejects a malformed package id', async () => {
    await expect(
      guard.canActivate(contextFor({ id: 42 }, '7', '5abc')),
    ).rejects.toThrow(ForbiddenException);
    expect(packages.findOne).not.toHaveBeenCalled();
  });
});
