import { NotFoundException } from '@nestjs/common';
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
});
