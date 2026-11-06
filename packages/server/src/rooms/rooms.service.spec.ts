import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CreateRoomDto } from './dto/create-room.dto';
import { RoomsService } from './rooms.service';

describe('RoomsService', () => {
  describe('create', () => {
    it('uses the authenticated user as author, ignoring dto.authorId', async () => {
      const roomsRepository = {
        create: jest.fn((value: unknown) => value),
        save: jest.fn(() => Promise.resolve({ id: 10 })),
        findOne: jest.fn(() => Promise.resolve({ id: 10 })),
        delete: jest.fn(),
      };
      const service = new RoomsService(roomsRepository as never);
      const author = { id: 7 } as never;

      await service.create(
        { name: 'Room', authorId: 999, type: 'godot' } as CreateRoomDto,
        author,
      );

      expect(roomsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Room', author }),
      );
    });

    it('initializes new rooms with author mode and empty access lists', async () => {
      const roomsRepository = {
        create: jest.fn((value: unknown) => value),
        save: jest.fn(() => Promise.resolve({ id: 10 })),
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 10,
            name: 'Test Room',
            author: { id: 7 },
            packageManagementAccess: 'author',
            packageManagementUserIds: [],
            packageCreationAccess: 'author',
            packageCreationUserIds: [],
          }),
        ),
        delete: jest.fn(),
      };
      const service = new RoomsService(roomsRepository as never);
      const author = { id: 7 } as never;

      await service.create(
        { name: 'Test Room', type: 'godot' } as CreateRoomDto,
        author,
      );

      expect(roomsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          packageManagementAccess: 'author',
          packageManagementUserIds: [],
          packageCreationAccess: 'author',
          packageCreationUserIds: [],
        }),
      );
    });
  });

  describe('visibility', () => {
    const user = { id: 7 };

    function makeService(rooms: unknown[] = []) {
      const roomsRepository = {
        find: jest.fn(() => Promise.resolve(rooms)),
        findOne: jest.fn(() => Promise.resolve(rooms[0] ?? null)),
      };
      const service = new RoomsService(roomsRepository as never);
      return { service, roomsRepository };
    }

    it('lists only public rooms for anonymous users', async () => {
      const { service, roomsRepository } = makeService();

      await service.findAll(null);

      expect(roomsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isPublic: true } }),
      );
    });

    it('lists public, owned and contributed rooms for a user', async () => {
      const { service, roomsRepository } = makeService();

      await service.findAll(user as never);

      expect(roomsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: [
            { isPublic: true },
            { author: { id: user.id } },
            { contributors: { id: user.id } },
          ],
          relationLoadStrategy: 'query',
        }),
      );
    });

    it('rejects a stranger reading a private room', async () => {
      const { service } = makeService([
        { id: 3, isPublic: false, author: { id: 1 }, contributors: [] },
      ]);

      await expect(
        service.findVisibleOne(3, { id: 2 } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows a contributor to read a private room', async () => {
      const { service } = makeService([
        {
          id: 3,
          isPublic: false,
          author: { id: 1 },
          contributors: [{ id: 7 }],
        },
      ]);

      await expect(
        service.findVisibleOne(3, user as never),
      ).resolves.toMatchObject({ id: 3 });
    });

    it('allows anonymous users to read a public room', async () => {
      const { service } = makeService([
        { id: 3, isPublic: true, author: { id: 1 }, contributors: [] },
      ]);

      await expect(service.findVisibleOne(3, null)).resolves.toMatchObject({
        id: 3,
      });
    });
  });

  describe('onApplicationBootstrap', () => {
    it('backfills null packageManagementAccess with author and contributors', async () => {
      const room = {
        id: 1,
        author: { id: 10 },
        contributors: [{ id: 20 }, { id: 30 }],
        packageManagementAccess: null,
        packageManagementUserIds: null,
        packageCreationAccess: 'author',
        packageCreationUserIds: [],
      };

      const roomsRepository = {
        find: jest.fn(() => Promise.resolve([room])),
        save: jest.fn(),
      };

      const service = new RoomsService(roomsRepository as never);
      await service.onApplicationBootstrap();

      expect(roomsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          packageManagementAccess: 'users',
          packageManagementUserIds: expect.arrayContaining([10, 20, 30]),
        }),
      );
    });

    it('backfills null packageCreationAccess with author and contributors', async () => {
      const room = {
        id: 2,
        author: { id: 5 },
        contributors: [{ id: 15 }],
        packageManagementAccess: 'author',
        packageManagementUserIds: [],
        packageCreationAccess: null,
        packageCreationUserIds: null,
      };

      const roomsRepository = {
        find: jest.fn(() => Promise.resolve([room])),
        save: jest.fn(),
      };

      const service = new RoomsService(roomsRepository as never);
      await service.onApplicationBootstrap();

      expect(roomsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 2,
          packageCreationAccess: 'users',
          packageCreationUserIds: expect.arrayContaining([5, 15]),
        }),
      );
    });

    it('backfills null userIds to empty arrays when access mode is set', async () => {
      const room = {
        id: 3,
        author: { id: 7 },
        contributors: [],
        packageManagementAccess: 'author',
        packageManagementUserIds: null,
        packageCreationAccess: 'author',
        packageCreationUserIds: null,
      };

      const roomsRepository = {
        find: jest.fn(() => Promise.resolve([room])),
        save: jest.fn(),
      };

      const service = new RoomsService(roomsRepository as never);
      await service.onApplicationBootstrap();

      expect(roomsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 3,
          packageManagementUserIds: [],
          packageCreationUserIds: [],
        }),
      );
    });

    it('skips rooms with both access fields already set', async () => {
      const room = {
        id: 4,
        author: { id: 1 },
        contributors: [],
        packageManagementAccess: 'users',
        packageManagementUserIds: [1],
        packageCreationAccess: 'all',
        packageCreationUserIds: [],
      };

      const roomsRepository = {
        find: jest.fn(() => Promise.resolve([room])),
        save: jest.fn(),
      };

      const service = new RoomsService(roomsRepository as never);
      await service.onApplicationBootstrap();

      expect(roomsRepository.save).not.toHaveBeenCalled();
    });

    it('deduplicates author and contributors in backfilled lists', async () => {
      const room = {
        id: 5,
        author: { id: 100 },
        contributors: [{ id: 100 }, { id: 200 }, { id: 200 }],
        packageManagementAccess: null,
        packageManagementUserIds: null,
        packageCreationAccess: null,
        packageCreationUserIds: null,
      };

      const roomsRepository = {
        find: jest.fn(() => Promise.resolve([room])),
        save: jest.fn(),
      };

      const service = new RoomsService(roomsRepository as never);
      await service.onApplicationBootstrap();

      const savedCall = (roomsRepository.save as jest.Mock).mock.calls[0][0];
      const uniqueIds = new Set(savedCall.packageManagementUserIds);
      expect(uniqueIds.size).toBe(2); // Only 100 and 200
      expect(uniqueIds).toContain(100);
      expect(uniqueIds).toContain(200);
    });
  });

  describe('assertRoomAccessEditing', () => {
    it('throws ForbiddenException when user is not the room author', async () => {
      const roomsRepository = {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 1,
            author: { id: 10 },
            contributors: [{ id: 20 }],
          }),
        ),
      };

      const service = new RoomsService(roomsRepository as never);
      const user = { id: 999 } as never;

      await expect(
        service.assertRoomAccessEditing(user, 1),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the room author to edit', async () => {
      const roomsRepository = {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 1,
            author: { id: 10 },
            contributors: [{ id: 20 }],
          }),
        ),
      };

      const service = new RoomsService(roomsRepository as never);
      const user = { id: 10 } as never;

      await expect(
        service.assertRoomAccessEditing(user, 1),
      ).resolves.toBeUndefined();
    });

    it('throws ForbiddenException when a contributor tries to edit room access', async () => {
      const roomsRepository = {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 1,
            author: { id: 10 },
            contributors: [{ id: 20 }],
          }),
        ),
      };

      const service = new RoomsService(roomsRepository as never);
      const contributor = { id: 20 } as never;

      await expect(
        service.assertRoomAccessEditing(contributor, 1),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFoundException when room does not exist', async () => {
      const roomsRepository = {
        findOne: jest.fn(() => Promise.reject(new NotFoundException())),
      };

      const service = new RoomsService(roomsRepository as never);
      const user = { id: 10 } as never;

      await expect(
        service.assertRoomAccessEditing(user, 999),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
