import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CreateRoomDto } from './dto/create-room.dto';
import { RoomsService } from './rooms.service';
import { UsersService } from 'src/users/users.service';
import { UpdateRoomAccessDto } from './dto/update-room-access.dto';

describe('RoomsService', () => {
  describe('create', () => {
    it('uses the authenticated user as author, ignoring dto.authorId', async () => {
      const roomsRepository = {
        create: jest.fn((value: unknown) => value),
        save: jest.fn(() => Promise.resolve({ id: 10 })),
        findOne: jest.fn(() => Promise.resolve({ id: 10 })),
        delete: jest.fn(),
      };
      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
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
      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
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
      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
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

      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
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

      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
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

      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
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

      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
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

      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
      await service.onApplicationBootstrap();

      const savedCall = roomsRepository.save.mock.calls[0][0];
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

      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
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

      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
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

      const usersService = {} as never;
      const service = new RoomsService(roomsRepository as never, usersService);
      const contributor = { id: 20 } as never;

      await expect(
        service.assertRoomAccessEditing(contributor, 1),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFoundException when room does not exist', async () => {
      const roomsRepository = {
        findOne: jest.fn(() => Promise.reject(new NotFoundException())),
      };

      const service = new RoomsService(roomsRepository as never, {} as never);
      const user = { id: 10 } as never;

      await expect(
        service.assertRoomAccessEditing(user, 999),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateAccess', () => {
    it('validates that all provided user IDs exist before updating', async () => {
      const usersService = {
        findById: jest.fn((id) => Promise.resolve(id === 5 ? { id: 5 } : null)),
      };

      const roomsRepository = {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 1,
            author: { id: 10 },
            contributors: [],
            packageManagementAccess: 'author',
            packageManagementUserIds: [],
            packageCreationAccess: 'author',
            packageCreationUserIds: [],
          }),
        ),
        save: jest.fn(),
      };

      const service = new RoomsService(
        roomsRepository as never,
        usersService as never,
      );
      const user = { id: 10 } as never;
      const dto: UpdateRoomAccessDto = {
        packageManagementAccess: 'users',
        packageManagementUserIds: [5, 999],
      };

      await expect(service.updateAccess(1, dto, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.updateAccess(1, dto, user)).rejects.toMatchObject({
        message: expect.stringContaining('999'),
      });
    });

    it('rejects with a list of all invalid user IDs', async () => {
      const usersService = {
        findById: jest.fn((id) => Promise.resolve(id === 5 ? { id: 5 } : null)),
      };

      const roomsRepository = {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 1,
            author: { id: 10 },
            contributors: [],
            packageManagementAccess: 'author',
            packageManagementUserIds: [],
            packageCreationAccess: 'author',
            packageCreationUserIds: [],
          }),
        ),
        save: jest.fn(),
      };

      const service = new RoomsService(
        roomsRepository as never,
        usersService as never,
      );
      const user = { id: 10 } as never;
      const dto: UpdateRoomAccessDto = {
        packageManagementUserIds: [999, 888],
        packageCreationUserIds: [777],
      };

      await expect(service.updateAccess(1, dto, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      try {
        await service.updateAccess(1, dto, user);
      } catch (error) {
        expect((error as BadRequestException).message).toContain('999');
        expect((error as BadRequestException).message).toContain('888');
        expect((error as BadRequestException).message).toContain('777');
      }
    });

    it('allows updateAccess when all provided user IDs exist', async () => {
      const usersService = {
        findById: jest.fn((id) => Promise.resolve({ id })),
      };

      const roomsRepository = {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 1,
            author: { id: 10 },
            contributors: [],
            packageManagementAccess: 'author',
            packageManagementUserIds: [],
            packageCreationAccess: 'author',
            packageCreationUserIds: [],
          }),
        ),
        save: jest.fn(() => Promise.resolve({ id: 1 })),
      };

      const service = new RoomsService(
        roomsRepository as never,
        usersService as never,
      );
      const user = { id: 10 } as never;
      const dto: UpdateRoomAccessDto = {
        packageManagementAccess: 'users',
        packageManagementUserIds: [5, 15],
      };

      await expect(service.updateAccess(1, dto, user)).resolves.toBeDefined();

      expect(roomsRepository.save).toHaveBeenCalled();
    });

    it('allows updateAccess with no user IDs provided', async () => {
      const usersService = {
        findById: jest.fn(),
      };

      const roomsRepository = {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 1,
            author: { id: 10 },
            contributors: [],
            packageManagementAccess: 'author',
            packageManagementUserIds: [],
            packageCreationAccess: 'author',
            packageCreationUserIds: [],
          }),
        ),
        save: jest.fn(() => Promise.resolve({ id: 1 })),
      };

      const service = new RoomsService(
        roomsRepository as never,
        usersService as never,
      );
      const user = { id: 10 } as never;
      const dto: UpdateRoomAccessDto = {
        packageManagementAccess: 'author',
      };

      await expect(service.updateAccess(1, dto, user)).resolves.toBeDefined();

      expect(usersService.findById).not.toHaveBeenCalled();
      expect(roomsRepository.save).toHaveBeenCalled();
    });

    it('skips validation when user ID arrays are empty', async () => {
      const usersService = {
        findById: jest.fn(),
      };

      const roomsRepository = {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 1,
            author: { id: 10 },
            contributors: [],
            packageManagementAccess: 'users',
            packageManagementUserIds: [5],
            packageCreationAccess: 'users',
            packageCreationUserIds: [5],
          }),
        ),
        save: jest.fn(() => Promise.resolve({ id: 1 })),
      };

      const service = new RoomsService(
        roomsRepository as never,
        usersService as never,
      );
      const user = { id: 10 } as never;
      const dto: UpdateRoomAccessDto = {
        packageManagementUserIds: [],
        packageCreationUserIds: [],
      };

      await expect(service.updateAccess(1, dto, user)).resolves.toBeDefined();

      expect(usersService.findById).not.toHaveBeenCalled();
    });

    it('deduplicates user IDs when validating', async () => {
      const usersService = {
        findById: jest.fn((id) => Promise.resolve({ id })),
      };

      const roomsRepository = {
        findOne: jest.fn(() =>
          Promise.resolve({
            id: 1,
            author: { id: 10 },
            contributors: [],
            packageManagementAccess: 'author',
            packageManagementUserIds: [],
            packageCreationAccess: 'author',
            packageCreationUserIds: [],
          }),
        ),
        save: jest.fn(() => Promise.resolve({ id: 1 })),
      };

      const service = new RoomsService(
        roomsRepository as never,
        usersService as never,
      );
      const user = { id: 10 } as never;
      const dto: UpdateRoomAccessDto = {
        packageManagementUserIds: [5, 5, 15, 15],
        packageCreationUserIds: [5],
      };

      await expect(service.updateAccess(1, dto, user)).resolves.toBeDefined();

      // Each unique user ID should be validated once, not multiple times
      // With Set deduplication, we expect 3 unique IDs: 5, 15
      expect(usersService.findById).toHaveBeenCalledTimes(2);
      expect(usersService.findById).toHaveBeenCalledWith(5);
      expect(usersService.findById).toHaveBeenCalledWith(15);
    });
  });
});
