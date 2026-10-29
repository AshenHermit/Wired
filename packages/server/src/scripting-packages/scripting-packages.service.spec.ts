import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScriptingPackagesService } from './scripting-packages.service';

describe('ScriptingPackagesService', () => {
  describe('assertPackageEditing', () => {
    const author = { id: 1 };
    const contributor = { id: 2 };
    const roomAuthor = { id: 3 };
    const stranger = { id: 4 };

    function makeService(pkg: unknown) {
      const packagesRepository = { findOne: jest.fn(async () => pkg) };
      return new ScriptingPackagesService(
        packagesRepository as never,
        {} as never,
      );
    }

    it('allows the package author', async () => {
      const service = makeService({
        id: 10,
        author,
        contributors: [],
        room: null,
      });
      await expect(
        service.assertPackageEditing(author as never, 10),
      ).resolves.toBeUndefined();
    });

    it('allows a package contributor', async () => {
      const service = makeService({
        id: 10,
        author,
        contributors: [contributor],
        room: null,
      });
      await expect(
        service.assertPackageEditing(contributor as never, 10),
      ).resolves.toBeUndefined();
    });

    it('allows the author of the owning room', async () => {
      const service = makeService({
        id: 10,
        author,
        contributors: [],
        room: { id: 5, author: roomAuthor },
      });
      await expect(
        service.assertPackageEditing(roomAuthor as never, 10),
      ).resolves.toBeUndefined();
    });

    it('rejects a stranger even when the package belongs to a room', async () => {
      const service = makeService({
        id: 10,
        author,
        contributors: [],
        room: { id: 5, author: roomAuthor },
      });
      await expect(
        service.assertPackageEditing(stranger as never, 10),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a stranger for a standalone package', async () => {
      const service = makeService({
        id: 10,
        author,
        contributors: [],
        room: null,
      });
      await expect(
        service.assertPackageEditing(stranger as never, 10),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the package does not exist', async () => {
      const service = makeService(null);
      await expect(
        service.assertPackageEditing(stranger as never, 10),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    const user = { id: 1 };
    const roomAuthor = { id: 1 };
    const stranger = { id: 2 };

    function makeService(room: unknown) {
      const packagesRepository = {
        create: jest.fn((value: unknown) => value),
        save: jest.fn(async (value: unknown) => value),
        findOne: jest.fn(async () => ({ id: 10 })),
      };
      const roomsRepository = { findOne: jest.fn(async () => room) };
      return {
        packagesRepository,
        roomsRepository,
        service: new ScriptingPackagesService(
          packagesRepository as never,
          roomsRepository as never,
        ),
      };
    }

    it('rejects attaching a package to a room the caller cannot edit', async () => {
      const { service, packagesRepository } = makeService({
        id: 5,
        author: roomAuthor,
        contributors: [],
      });

      await expect(
        service.create(
          { name: 'pkg', version: '0.1.0', roomId: 5 } as never,
          stranger as never,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(packagesRepository.save).not.toHaveBeenCalled();
    });

    it('takes the author from the authenticated user', async () => {
      const { service, packagesRepository } = makeService({
        id: 5,
        author: user,
        contributors: [],
      });

      await service.create(
        { name: 'pkg', version: '0.1.0', roomId: 5 } as never,
        user as never,
      );

      expect(packagesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ author: user }),
      );
    });
  });

  describe('update', () => {
    it('ignores authorId and roomId so ownership cannot be transferred', async () => {
      const author = { id: 1 };
      const room = { id: 5 };
      const pkg = { id: 10, author, room };
      const packagesRepository = {
        findOne: jest.fn(async () => pkg),
        save: jest.fn(async (value: unknown) => ({
          ...(value as object),
          id: 10,
        })),
      };
      const roomsRepository = { findOne: jest.fn() };
      const service = new ScriptingPackagesService(
        packagesRepository as never,
        roomsRepository as never,
      );

      await service.update(10, {
        name: 'renamed',
        authorId: 99,
        roomId: 99,
      } as never);

      expect(packagesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ author, room, name: 'renamed' }),
      );
      expect(roomsRepository.findOne).not.toHaveBeenCalled();
    });
  });
});
