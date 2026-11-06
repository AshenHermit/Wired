import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { IsNull, Not } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackagesService } from './scripting-packages.service';
import { PackagePublishLockService } from './publish/package-publish-lock.service';

/**
 * Collaborators the service refuses to run without.
 *
 * Specs that only care about one of them still have to pass the rest, because
 * the service treats an unregistered collaborator as a wiring error rather than
 * silently skipping the work it would have done.
 */
function collaborators(
  overrides: {
    storage?: unknown;
    dispatcher?: unknown;
    delivery?: unknown;
    revisions?: unknown;
    locks?: unknown;
  } = {},
): [never, never, never, never, never] {
  return [
    (overrides.storage ?? {}) as never,
    (overrides.dispatcher ?? {}) as never,
    (overrides.delivery ?? {
      findDependentRoomPackages: jest.fn(async () => []),
      invalidatePackage: jest.fn(async () => undefined),
    }) as never,
    (overrides.revisions ?? {}) as never,
    (overrides.locks ?? new PackagePublishLockService()) as never,
  ];
}

type FakeManager = {
  query: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
  delete: jest.Mock;
  getRepository: jest.Mock;
  transaction: jest.Mock;
};

/**
 * Transaction-manager double: `transaction` hands the callback the manager
 * itself and `getRepository` returns per-entity repository doubles.
 */
function makeTransactionManager(
  options: {
    liveFindOne?: jest.Mock;
    save?: jest.Mock;
    delete?: jest.Mock;
  } = {},
): FakeManager {
  const manager = {
    query: jest.fn(async () => []),
    findOne: options.liveFindOne ?? jest.fn(async () => null),
    save:
      options.save ??
      jest.fn(async (_entity: unknown, value: unknown) => value),
    delete: options.delete ?? jest.fn(async () => ({ affected: 1 })),
    getRepository: jest.fn(),
    transaction: jest.fn(),
  } as FakeManager;
  manager.getRepository.mockImplementation(() => ({
    create: (value: unknown) => value,
    findOne: manager.findOne,
    save: manager.save,
  }));
  manager.transaction.mockImplementation(
    async (work: (current: FakeManager) => Promise<unknown>) => work(manager),
  );
  return manager;
}

/** Gives a fake repository the `manager.transaction` the service expects. */
function attachTransactionManager(
  repository: Record<string, unknown> & {
    delete?: (id: number) => Promise<unknown>;
  },
  options: { save?: jest.Mock; liveFindOne?: jest.Mock } = {},
): void {
  const manager = makeTransactionManager({
    save: options.save,
    liveFindOne: options.liveFindOne,
    delete: jest.fn(async (_entity: unknown, id: number) =>
      repository.delete ? repository.delete(id) : { affected: 1 },
    ),
  });
  repository.manager = { transaction: manager.transaction };
}

describe('ScriptingPackagesService', () => {
  describe('findVisibleOne', () => {
    const author = { id: 1 };
    const contributor = { id: 2 };
    const stranger = { id: 4 };

    function makeService(pkg: unknown) {
      const packagesRepository = { findOne: jest.fn(async () => pkg) };
      return new ScriptingPackagesService(
        packagesRepository as never,
        {} as never,
        ...collaborators(),
      );
    }

    it('serves a workshop package to an anonymous viewer', async () => {
      const service = makeService({ id: 10, room: null });

      await expect(service.findVisibleOne(10, null)).resolves.toEqual({
        id: 10,
        room: null,
      });
    });

    it('serves a package of a public room to anyone', async () => {
      const service = makeService({
        id: 10,
        room: { id: 5, isPublic: true, author, contributors: [] },
      });

      await expect(service.findVisibleOne(10, null)).resolves.toMatchObject({
        id: 10,
      });
    });

    it('hides a private-room package from a stranger', async () => {
      const service = makeService({
        id: 10,
        room: { id: 5, isPublic: false, author, contributors: [contributor] },
      });

      await expect(
        service.findVisibleOne(10, stranger as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('serves a private-room package to a contributor', async () => {
      const service = makeService({
        id: 10,
        room: { id: 5, isPublic: false, author, contributors: [contributor] },
      });

      await expect(
        service.findVisibleOne(10, contributor as never),
      ).resolves.toMatchObject({ id: 10 });
    });

    it('answers 404 for a missing package', async () => {
      const service = makeService(null);

      await expect(service.findVisibleOne(10, null)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

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
        ...collaborators(),
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

    it('keeps PATCH/DELETE closed to room contributors', async () => {
      const service = makeService({
        id: 10,
        author,
        contributors: [],
        room: { id: 5, author: roomAuthor, contributors: [contributor] },
      });
      await expect(
        service.assertPackageEditing(contributor as never, 10),
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

  describe('assertPackagePublishing', () => {
    function makeService(pkg: unknown) {
      const packagesRepository = { findOne: jest.fn(async () => pkg) };
      return new ScriptingPackagesService(
        packagesRepository as never,
        {} as never,
        ...collaborators(),
      );
    }

    it('lets a room contributor publish a revision', async () => {
      const service = makeService({
        id: 10,
        author: { id: 1 },
        contributors: [],
        room: { id: 5, author: { id: 3 }, contributors: [{ id: 2 }] },
      });
      await expect(
        service.assertPackagePublishing({ id: 2 } as never, 10),
      ).resolves.toBeUndefined();
    });

    it('rejects revision endpoints for a global package', async () => {
      const service = makeService({
        id: 10,
        author: { id: 1 },
        contributors: [],
        room: null,
      });
      await expect(
        service.assertPackagePublishing({ id: 1 } as never, 10),
      ).rejects.toMatchObject({ response: { code: 'package_not_in_room' } });
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
      attachTransactionManager(packagesRepository, {
        save: packagesRepository.save,
      });
      const roomsRepository = { findOne: jest.fn(async () => room) };
      return {
        packagesRepository,
        roomsRepository,
        service: new ScriptingPackagesService(
          packagesRepository as never,
          roomsRepository as never,
          ...collaborators(),
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
          { name: 'pkg', version: '0.1.0', slug: 'pkg', roomId: 5 } as never,
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
        { name: 'pkg', version: '0.1.0', slug: 'pkg', roomId: 5 } as never,
        user as never,
      );

      expect(packagesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ author: user }),
      );
    });

    it('normalizes tags on creation', async () => {
      const { service, packagesRepository } = makeService({
        id: 5,
        author: user,
        contributors: [],
      });

      await service.create(
        {
          name: 'pkg',
          version: '0.1.0',
          slug: 'pkg',
          roomId: 5,
          tags: [' Hero ', '2D', 'hero'],
        } as never,
        user as never,
      );

      expect(packagesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['hero', '2d'] }),
      );
    });

    it('rejects invalid tags on creation', async () => {
      const { service, packagesRepository } = makeService({
        id: 5,
        author: user,
        contributors: [],
      });

      await expect(
        service.create(
          {
            name: 'pkg',
            version: '0.1.0',
            slug: 'pkg',
            roomId: 5,
            tags: ['плохой'],
          } as never,
          user as never,
        ),
      ).rejects.toMatchObject({ response: { code: 'invalid_tags' } });
      expect(packagesRepository.save).not.toHaveBeenCalled();
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
        ...collaborators(),
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

    function makeTagService(pkg: { id: number; tags: string[] }) {
      const packagesRepository = {
        findOne: jest.fn(async () => pkg),
        save: jest.fn(async (value: unknown) => value),
      };
      const service = new ScriptingPackagesService(
        packagesRepository as never,
        {} as never,
        ...collaborators(),
      );
      return { service, packagesRepository };
    }

    it('normalizes tags on update', async () => {
      const { service, packagesRepository } = makeTagService({
        id: 10,
        tags: [],
      });

      await service.update(10, { tags: [' Hero ', '2D', 'hero'] });

      expect(packagesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['hero', '2d'] }),
      );
    });

    it('rejects invalid tags on update before saving', async () => {
      const { service, packagesRepository } = makeTagService({
        id: 10,
        tags: ['old'],
      });

      await expect(
        service.update(10, { tags: ['плохой'] }),
      ).rejects.toMatchObject({ response: { code: 'invalid_tags' } });
      expect(packagesRepository.save).not.toHaveBeenCalled();
    });

    it('keeps tags untouched when the update does not carry them', async () => {
      const { service, packagesRepository } = makeTagService({
        id: 10,
        tags: ['old'],
      });

      await service.update(10, { name: 'renamed' });

      expect(packagesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['old'] }),
      );
    });
  });

  describe('remove', () => {
    function makeService(options: {
      pkg?: unknown;
      affected?: number;
      removePackage?: jest.Mock;
    }) {
      const packagesRepository = {
        findOne: jest.fn(async () =>
          options.pkg !== undefined ? options.pkg : { id: 10 },
        ),
        delete: jest.fn(async () => ({ affected: options.affected ?? 1 })),
      };
      attachTransactionManager(packagesRepository);
      const storage = {
        removePackage: options.removePackage ?? jest.fn(async () => undefined),
      };
      return {
        packagesRepository,
        storage,
        service: new ScriptingPackagesService(
          packagesRepository as never,
          {} as never,
          ...collaborators({ storage }),
        ),
      };
    }

    it('deletes the package row and every stored file of the package', async () => {
      const { service, packagesRepository, storage } = makeService({});

      await service.remove(10);

      expect(packagesRepository.delete).toHaveBeenCalledWith(10);
      expect(storage.removePackage).toHaveBeenCalledWith(10);
    });

    it('does not touch the disk when the package does not exist', async () => {
      const { service, storage } = makeService({ pkg: null });

      await expect(service.remove(10)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(storage.removePackage).not.toHaveBeenCalled();
    });

    it('reports a missing row without removing files', async () => {
      const { service, storage } = makeService({ affected: 0 });

      await expect(service.remove(10)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(storage.removePackage).not.toHaveBeenCalled();
    });

    it('keeps the deletion when the files cannot be removed', async () => {
      const { service } = makeService({
        removePackage: jest.fn(async () => {
          throw new Error('disk busy');
        }),
      });

      await expect(service.remove(10)).resolves.toBeUndefined();
    });
  });

  describe('room lifecycle notifications', () => {
    function makeService(options: {
      pkg?: unknown;
      dispatcher?: {
        packageEnabledChanged: jest.Mock;
        packageRemoved: jest.Mock;
      };
    }) {
      const pkg =
        options.pkg !== undefined ? options.pkg : { id: 10, enabled: true };
      const packagesRepository = {
        findOne: jest.fn(async () => pkg),
        save: jest.fn(async (value: unknown) => value),
        delete: jest.fn(async () => ({ affected: 1 })),
      };
      attachTransactionManager(packagesRepository);
      const dispatcher = options.dispatcher ?? {
        packageEnabledChanged: jest.fn(async () => undefined),
        packageRemoved: jest.fn(),
      };
      return {
        packagesRepository,
        dispatcher,
        service: new ScriptingPackagesService(
          packagesRepository as never,
          {} as never,
          ...collaborators({ dispatcher }),
        ),
      };
    }

    it('notifies the dispatcher when enabled flips', async () => {
      const { service, dispatcher } = makeService({});

      await service.update(10, { enabled: false });

      expect(dispatcher.packageEnabledChanged).toHaveBeenCalledWith(10);
    });

    it('does not notify when enabled is unchanged', async () => {
      const { service, dispatcher } = makeService({});

      await service.update(10, { enabled: true });

      expect(dispatcher.packageEnabledChanged).not.toHaveBeenCalled();
    });

    it('notifies removal with the room id', async () => {
      const { service, dispatcher } = makeService({
        pkg: { id: 10, room: { id: 7 } },
      });

      await service.remove(10);

      expect(dispatcher.packageRemoved).toHaveBeenCalledWith(10, 7);
    });

    it('does not notify removal for a package outside a room', async () => {
      const { service, dispatcher } = makeService({
        pkg: { id: 10, room: null },
      });

      await service.remove(10);

      expect(dispatcher.packageRemoved).not.toHaveBeenCalled();
    });

    it('keeps the deletion when the dispatcher throws', async () => {
      const { service, dispatcher } = makeService({
        pkg: { id: 10, room: { id: 7 } },
      });
      dispatcher.packageRemoved.mockImplementation(() => {
        throw new Error('runtime offline');
      });

      await expect(service.remove(10)).resolves.toBeUndefined();
    });

    it('keeps the update when the dispatcher rejects', async () => {
      const { service, dispatcher } = makeService({});
      dispatcher.packageEnabledChanged.mockRejectedValue(
        new Error('runtime offline'),
      );

      await expect(service.update(10, { enabled: false })).resolves.toEqual(
        expect.objectContaining({ id: 10 }),
      );
    });
  });

  describe('delete dependency guard', () => {
    function makeService(options: {
      dependents?: Array<{
        packageId: number;
        roomId: number;
        revision: number;
      }>;
      rows?: Array<{ id: number; name: string; enabled: boolean }>;
    }) {
      const packagesRepository = {
        findOne: jest.fn(async () => ({ id: 42, room: { id: 7 } })),
        find: jest.fn(async () => options.rows ?? []),
        delete: jest.fn(async () => ({ affected: 1 })),
      };
      attachTransactionManager(packagesRepository);
      const delivery = {
        findDependentRoomPackages: jest.fn(
          async () => options.dependents ?? [],
        ),
      };
      return {
        packagesRepository,
        delivery,
        service: new ScriptingPackagesService(
          packagesRepository as never,
          {} as never,
          {} as never,
          {} as never,
          delivery as never,
          {} as never,
          new PackagePublishLockService(),
        ),
      };
    }

    it('refuses to delete a package with enabled room dependents', async () => {
      const { service, packagesRepository } = makeService({
        dependents: [{ packageId: 9, roomId: 7, revision: 2 }],
        rows: [{ id: 9, name: 'Dep', enabled: true }],
      });

      await expect(service.remove(42)).rejects.toMatchObject({
        response: {
          code: 'package_has_dependents',
          dependents: [{ packageId: 9, name: 'Dep' }],
        },
      });
      expect(packagesRepository.delete).not.toHaveBeenCalled();
    });

    it('deletes when every dependent is disabled', async () => {
      const { service, packagesRepository } = makeService({
        dependents: [{ packageId: 9, roomId: 7, revision: 2 }],
        rows: [{ id: 9, name: 'Dep', enabled: false }],
      });

      await service.remove(42);

      expect(packagesRepository.delete).toHaveBeenCalledWith(42);
    });
  });
});

describe('ScriptingPackagesService slug lifecycle', () => {
  function makeSlugService(
    options: {
      query?: jest.Mock;
      findOne?: jest.Mock;
      save?: jest.Mock;
      manager?: FakeManager;
      pkg?: unknown;
      room?: unknown;
    } = {},
  ) {
    const manager =
      options.manager ??
      makeTransactionManager({
        save: options.save,
      });
    const packagesRepository = {
      query: options.query ?? jest.fn(async () => []),
      findOne:
        options.findOne ??
        jest.fn(async () => options.pkg ?? { id: 7, slug: 'hero' }),
      manager,
    };
    const roomsRepository = {
      findOne: jest.fn(async () => options.room ?? null),
    };
    // The slug lifecycle only needs the packages repository; the collaborators
    // are present because the service refuses to boot without them.
    return new ScriptingPackagesService(
      packagesRepository as never,
      roomsRepository as never,
      {} as never,
      {} as never,
      { findDependentRoomPackages: jest.fn(async () => []) } as never,
      {} as never,
      new PackagePublishLockService(),
    );
  }

  it('backfills null slugs from the numeric id', async () => {
    const query = jest.fn(async () => []);
    const service = makeSlugService({ query });
    await service.onApplicationBootstrap();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE scripting_package'),
    );
  });

  it('backfills null editingAccess to users mode with author and contributors', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // slug backfill returns empty
      .mockResolvedValueOnce([]); // no missing slugs
    const service = makeSlugService({ query });
    await service.onApplicationBootstrap();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('editingAccess'),
    );
  });

  it('creates packages with author mode and empty editing user list', async () => {
    const user = { id: 1 };
    const room = { id: 5, author: user, contributors: [] };
    const save = jest.fn(async (value: unknown) => ({
      ...(value as object),
      id: 10,
    }));
    const manager = makeTransactionManager({ save });
    const packagesRepository = {
      create: jest.fn((value: unknown) => value),
      save,
      findOne: jest.fn(async () => ({ id: 10 })),
      manager,
    };
    const roomsRepository = { findOne: jest.fn(async () => room) };
    const service = new ScriptingPackagesService(
      packagesRepository as never,
      roomsRepository as never,
      ...collaborators(),
    );

    await service.create(
      {
        name: 'Hero',
        version: '0.1.0',
        slug: 'hero',
        roomId: 5,
      } as never,
      user as never,
    );

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        editingAccess: 'author',
        editingUserIds: [],
      }),
    );
  });

  it('fails fast when the backfill leaves packages without a slug', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 5 }]);
    const service = makeSlugService({ query });
    const logger = (service as unknown as { logger: { error: jest.Mock } })
      .logger;
    const errorSpy = jest
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      'package_slug_backfill_incomplete',
    );
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('WHERE slug IS NULL'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('5'));
    errorSpy.mockRestore();
  });

  it('reports a live global slug as taken', async () => {
    const service = makeSlugService({
      findOne: jest.fn(async () => ({ id: 7, slug: 'hero' })),
    });
    await expect(service.checkSlugAvailability('hero')).resolves.toEqual({
      slug: 'hero',
      available: false,
      reason: 'taken',
      global: { available: false, reason: 'taken' },
    });
  });

  it('reports a deleted global slug as available', async () => {
    const findOne = jest.fn(async () => null);
    const service = makeSlugService({ findOne });

    await expect(service.checkSlugAvailability('hero')).resolves.toEqual({
      slug: 'hero',
      available: true,
      global: { available: true },
    });

    // Один запрос: живой строки нет — и больше ничего не проверяется.
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('reports an unused slug as available', async () => {
    const service = makeSlugService({ findOne: jest.fn(async () => null) });
    await expect(service.checkSlugAvailability('  hero_2  ')).resolves.toEqual({
      slug: 'hero_2',
      available: true,
      global: { available: true },
    });
  });

  it('checks availability in the requested room and reports the global scope', async () => {
    const findOne = jest.fn(
      async (options: { where: { room?: { id?: number } } }) =>
        options.where.room?.id === 5 ? { id: 7, slug: 'hero' } : null,
    );
    const service = makeSlugService({ findOne });

    await expect(service.checkSlugAvailability('hero', 5)).resolves.toEqual({
      slug: 'hero',
      available: false,
      reason: 'taken',
      global: { available: true },
    });
    expect(findOne).toHaveBeenCalledWith({
      where: { slug: 'hero', room: { id: 5 } },
    });
    expect(findOne).toHaveBeenCalledWith({
      where: { slug: 'hero', room: IsNull() },
    });
  });

  it('does not count the excluded package as the owner of its own slug', async () => {
    const findOne = jest
      .fn()
      .mockResolvedValueOnce({ id: 7, slug: 'hero' })
      .mockResolvedValueOnce(null);
    const service = makeSlugService({ findOne });

    await expect(service.checkSlugAvailability('hero', 3, 5)).resolves.toEqual({
      slug: 'hero',
      available: true,
      global: { available: false, reason: 'taken' },
    });
    expect(findOne).toHaveBeenCalledWith({
      where: { slug: 'hero', room: { id: 3 }, id: Not(5) },
    });
    expect(findOne).toHaveBeenCalledWith({
      where: { slug: 'hero', room: IsNull(), id: Not(5) },
    });
  });

  it('rejects an invalid slug with 400 invalid_slug', async () => {
    const service = makeSlugService();
    const error = await service
      .checkSlugAvailability('Hero')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'invalid_slug',
    });
  });

  const user = { id: 1 } as never;
  const ownRoom = { id: 5, author: { id: 1 }, contributors: [] };

  it('rejects a duplicate slug inside the same room', async () => {
    const manager = makeTransactionManager({
      liveFindOne: jest.fn(
        async (options: { where: { room?: { id: number } } }) =>
          options.where.room?.id === 5 ? { id: 7, slug: 'hero' } : null,
      ),
    });
    const service = makeSlugService({ manager, room: ownRoom });

    const error = await service
      .create(
        {
          name: 'Hero',
          version: '0.1.0',
          slug: 'hero',
          roomId: 5,
        },
        user,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'slug_taken',
      slug: 'hero',
      message: 'Slug уже занят',
    });
  });

  it('allows the same slug in two different rooms', async () => {
    const liveFindOne = jest.fn(
      async (options: { where: { room?: { id: number } } }) =>
        options.where.room?.id === 5 ? { id: 7, slug: 'hero' } : null,
    );
    const save = jest.fn(async (value: unknown) => ({
      ...(value as object),
      id: 10,
    }));
    const manager = makeTransactionManager({ liveFindOne, save });
    const service = makeSlugService({
      manager,
      room: { id: 6, author: { id: 1 }, contributors: [] },
    });

    await expect(
      service.create(
        {
          name: 'Hero',
          version: '0.1.0',
          slug: 'hero',
          roomId: 6,
        },
        user,
      ),
    ).resolves.toBeDefined();

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'hero',
        room: expect.objectContaining({ id: 6 }),
      }),
    );
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['package_slug:room:6:hero'],
    );
  });

  it('rejects public creation without a room', async () => {
    const manager = makeTransactionManager();
    const service = makeSlugService({ manager });

    await expect(
      service.create(
        { name: 'Hero', version: '1', slug: 'hero' } as never,
        user,
      ),
    ).rejects.toMatchObject({
      response: { code: 'package_room_required' },
    });
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('creates a global record outside any room with normalized tags', async () => {
    const save = jest.fn(async (value: unknown) => ({
      ...(value as object),
      id: 10,
    }));
    const manager = makeTransactionManager({ save });
    const service = makeSlugService({ manager });

    await service.createGlobalRecord({
      slug: ' hero ',
      name: 'Hero',
      version: '0.1.0',
      description: 'desc',
      tags: [' Hero ', '2D', 'hero'],
      author: { id: 1 } as never,
    });

    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['package_slug:global:hero'],
    );
    const saved = save.mock.calls[0][0] as {
      slug: string;
      room?: unknown;
      tags: string[];
      name: string;
    };
    expect(saved).toMatchObject({
      slug: 'hero',
      tags: ['hero', '2d'],
      name: 'Hero',
      version: '0.1.0',
      description: 'desc',
    });
    expect(saved.room).toBeUndefined();
  });

  it('maps a unique violation to slug_taken with an actionable message', async () => {
    const service = makeSlugService({
      room: ownRoom,
      save: jest.fn(async () => {
        throw Object.assign(new Error('duplicate slug'), { code: '23505' });
      }),
    });
    const error = await service
      .create(
        {
          name: 'Hero',
          version: '0.1.0',
          slug: 'hero',
          roomId: 5,
        },
        user,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'slug_taken',
      slug: 'hero',
      message: 'Slug уже занят',
    });
  });

  it('locks the room slug scope before deleting', async () => {
    const manager = makeTransactionManager();
    const service = makeSlugService({
      manager,
      pkg: { id: 10, slug: 'hero', room: { id: 5 } },
    });

    await service.remove(10);

    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['package_slug:room:5:hero'],
    );
    expect(manager.delete).toHaveBeenCalledWith(ScriptingPackage, 10);
  });

  it('clears parentPackageId of children before deleting', async () => {
    const manager = makeTransactionManager();
    const service = makeSlugService({
      manager,
      pkg: { id: 10, slug: 'hero', room: { id: 5 } },
    });

    await service.remove(10);

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'UPDATE scripting_package SET "parentPackageId" = NULL',
      ),
      [10],
    );
    const updateIndex = manager.query.mock.calls.findIndex(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('UPDATE scripting_package'),
    );
    expect(manager.query.mock.invocationCallOrder[updateIndex]).toBeLessThan(
      manager.delete.mock.invocationCallOrder[0],
    );
  });

  it('locks the global slug scope before deleting', async () => {
    const manager = makeTransactionManager();
    const service = makeSlugService({
      manager,
      pkg: { id: 10, slug: 'hero', room: null },
    });
    await service.remove(10);
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['package_slug:global:hero'],
    );
  });

  it('reports a concurrent double delete as not found', async () => {
    const manager = makeTransactionManager({
      delete: jest.fn(async () => ({ affected: 0 })),
    });
    const service = makeSlugService({ manager });
    await expect(service.remove(7)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ScriptingPackagesService enable guard', () => {
  function makeService(options: {
    pkg?: {
      id: number;
      name?: string;
      enabled: boolean;
      room: { id: number } | null;
    };
    dependencies?: Record<number, unknown>;
    pins?: Map<number, Map<number, number>>;
  }) {
    const pkg = options.pkg ?? {
      id: 42,
      name: 'B',
      enabled: false,
      room: { id: 7 },
    };
    const packagesRepository = {
      findOne: jest.fn(async (opts: { where: { id: number } }) => {
        if (opts.where.id === pkg.id) return pkg;
        return options.dependencies?.[opts.where.id] ?? null;
      }),
      save: jest.fn(async (value: unknown) => value),
    };
    const revisionsRepository = {
      findOne: jest.fn(
        async (opts: { where: { package: { id: number } } }) => ({
          package: { id: opts.where.package.id },
          revision: 1,
          status: 'published',
        }),
      ),
    };
    const storage = {
      readPinnedDependencies: jest.fn(
        async (packageId: number) =>
          options.pins?.get(packageId) ?? new Map<number, number>(),
      ),
    };
    const service = new ScriptingPackagesService(
      packagesRepository as never,
      {} as never,
      storage as never,
      {} as never,
      {} as never,
      revisionsRepository as never,
      new PackagePublishLockService(),
    );
    return { service, packagesRepository };
  }

  it('refuses to enable a package whose dependency was deleted', async () => {
    const { service, packagesRepository } = makeService({
      pins: new Map([[42, new Map([[99, 1]])]]),
      dependencies: {},
    });

    const error = await service
      .update(42, { enabled: true } as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'dependency_missing',
      dependencyId: 99,
    });
    expect(packagesRepository.save).not.toHaveBeenCalled();
  });

  it('enables when every pinned dependency still exists', async () => {
    const { service, packagesRepository } = makeService({
      pins: new Map([[42, new Map([[10, 1]])]]),
      dependencies: {
        10: { id: 10, name: 'A', enabled: true, room: { id: 7 } },
      },
    });

    await service.update(42, { enabled: true } as never);

    expect(packagesRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});

describe('canEditPackage', () => {
  function makeService() {
    return new ScriptingPackagesService(
      {} as never,
      {} as never,
      ...collaborators(),
    );
  }

  it('allows package author and room author when editingAccess is users', () => {
    const service = makeService();
    const pkg = {
      id: 1,
      author: { id: 5 },
      room: { id: 1, author: { id: 1 } },
      editingAccess: 'users',
      editingUserIds: [9],
    } as never;
    expect(service.canEditPackage(pkg, 5)).toBe(true);
    expect(service.canEditPackage(pkg, 1)).toBe(true);
    expect(service.canEditPackage(pkg, 9)).toBe(true);
    expect(service.canEditPackage(pkg, 3)).toBe(false);
  });

  it('allows only package author when editingAccess is author', () => {
    const service = makeService();
    const pkg2 = {
      id: 1,
      author: { id: 5 },
      room: { id: 1, author: { id: 1 } },
      editingAccess: 'author',
      editingUserIds: [],
    } as never;
    expect(service.canEditPackage(pkg2, 5)).toBe(true);
    expect(service.canEditPackage(pkg2, 1)).toBe(false);
    expect(service.canEditPackage(pkg2, undefined)).toBe(false);
  });

  it('allows all authenticated users when editingAccess is all', () => {
    const service = makeService();
    const pkgAll = {
      id: 1,
      author: { id: 5 },
      room: { id: 1, author: { id: 1 } },
      editingAccess: 'all',
      editingUserIds: [9],
    } as never;
    expect(service.canEditPackage(pkgAll, 5)).toBe(true);
    expect(service.canEditPackage(pkgAll, 999)).toBe(true);
    expect(service.canEditPackage(pkgAll, undefined)).toBe(false);
  });
});

describe('assertPackageAccessEditing', () => {
  function makeService(pkg: unknown) {
    const packagesRepository = { findOne: jest.fn(async () => pkg) };
    return new ScriptingPackagesService(
      packagesRepository as never,
      {} as never,
      ...collaborators(),
    );
  }

  it('throws ForbiddenException when non-author tries to access', async () => {
    const service = makeService({
      id: 1,
      author: { id: 5 },
      room: { id: 1, author: { id: 1 } },
      editingAccess: 'author',
      editingUserIds: [],
    });
    await expect(
      service.assertPackageAccessEditing({ id: 7 } as never, 1),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws NotFoundException when package does not exist', async () => {
    const service = makeService(null);
    await expect(
      service.assertPackageAccessEditing({ id: 1 } as never, 999),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ScriptingPackagesService slug rename', () => {
  type RevisionRow = {
    id?: number;
    revision: number;
    status: string;
    files?: unknown[];
  };

  function makeRenameService(
    options: {
      pkg?: Record<string, unknown>;
      self?: Record<string, unknown> | null;
      live?: Record<string, unknown> | null;
      ownRevisions?: RevisionRow[];
      dependentRevisions?: RevisionRow[];
      dependents?: Array<{
        packageId: number;
        roomId: number;
        revision: number;
      }>;
      dependentRows?: Array<{ id: number; name: string }>;
      rewrite?: jest.Mock;
    } = {},
  ) {
    const pkg = options.pkg ?? {
      id: 5,
      slug: 'hero',
      name: 'Hero',
      version: '1.0',
      tags: [],
      enabled: true,
      room: { id: 3 },
    };

    const manager: {
      query: jest.Mock;
      transaction: jest.Mock;
      getRepository: jest.Mock;
    } = {
      query: jest.fn(async () => []),
      transaction: jest.fn(),
      getRepository: jest.fn(),
    };

    const packages = {
      findOne: jest.fn(async (query: { where: { id?: number } }) =>
        query.where.id === undefined ? (options.live ?? null) : (options.self ?? pkg),
      ),
      find: jest.fn(async () => options.dependentRows ?? []),
      save: jest.fn(async (value: unknown) => value),
    };
    const revisions = {
      find: jest.fn(async (query: { where: { package: { id: number } } }) =>
        query.where.package.id === pkg.id
          ? (options.ownRevisions ?? [
              { id: 11, revision: 1, status: 'published' },
            ])
          : (options.dependentRevisions ?? [
              { id: 21, revision: 1, status: 'published' },
            ]),
      ),
      findOneOrFail: jest.fn(
        async (query: { where: { revision: number } }) => ({
          id: 100 + query.where.revision,
          revision: query.where.revision,
        }),
      ),
      update: jest.fn(async () => undefined),
    };

    manager.getRepository.mockImplementation((entity: unknown) =>
      entity === ScriptingPackage ? packages : revisions,
    );
    manager.transaction.mockImplementation(
      async (work: (current: unknown) => Promise<unknown>) => work(manager),
    );

    const packagesRepository = {
      findOne: jest.fn(async () => pkg),
      save: packages.save,
      manager,
    };
    const rewriteFiles =
      options.rewrite ??
      jest.fn(async () => [{ filepath: 'a.gd', size: 1, sha256: 'x' }]);
    const finishRewrite = jest.fn(
      async (_packageId: number, _revision: number, _kind: string) => undefined,
    );
    const abortRewrite = jest.fn(
      async (_packageId: number, _revision: number, _kind: string) => undefined,
    );
    // Mirrors PackageStorageService.beginRewrite: it prepares every target,
    // restores what it already moved when one fails, and only exposes commit
    // and abort to the caller.
    const beginRewrite = jest.fn(
      async (
        targets: Array<{
          packageId: number;
          revision: number;
          kind: 'published' | 'draft';
        }>,
        transform: unknown,
      ) => {
        const attempted: typeof targets = [];
        const results: Array<{
          target: (typeof targets)[number];
          files: Array<{ filepath: string; size: number; sha256: string }>;
        }> = [];
        try {
          for (const target of targets) {
            attempted.push(target);
            const files = await rewriteFiles(
              target.packageId,
              target.revision,
              target.kind,
              transform,
            );
            if (files) results.push({ target, files });
          }
        } catch (error) {
          for (const target of [...attempted].reverse()) {
            await abortRewrite(target.packageId, target.revision, target.kind);
          }
          throw error;
        }
        return {
          results,
          commit: async () => {
            for (const target of attempted) {
              await finishRewrite(target.packageId, target.revision, target.kind);
            }
          },
          abort: async () => {
            for (const target of [...attempted].reverse()) {
              await abortRewrite(target.packageId, target.revision, target.kind);
            }
          },
        };
      },
    );
    const storage = {
      beginRewrite,
      rewriteRevision: rewriteFiles,
      finishRewrite,
      abortRewrite,
    };
    const delivery = {
      findDependentRoomPackages: jest.fn(async () => options.dependents ?? []),
      invalidatePackage: jest.fn(async () => undefined),
    };
    const dispatcher = {
      packagesChanged: jest.fn(async () => undefined),
      packageEnabledChanged: jest.fn(async () => undefined),
      revisionPublished: jest.fn(async () => undefined),
      packageRemoved: jest.fn(),
    };

    const service = new ScriptingPackagesService(
      packagesRepository as never,
      {} as never,
      storage as never,
      dispatcher as never,
      delivery as never,
      revisions as never,
      new PackagePublishLockService(),
    );

    return {
      service,
      pkg,
      manager,
      packages,
      revisions,
      storage,
      delivery,
      dispatcher,
      packagesRepository,
    };
  }

  it('renames a room package and rewrites its published revisions', async () => {
    const { service, storage, delivery, dispatcher } = makeRenameService();

    const updated = await service.update(5, { slug: 'hero2' });

    expect(updated.slug).toBe('hero2');
    expect(storage.rewriteRevision).toHaveBeenCalledWith(
      5,
      1,
      'published',
      expect.any(Function),
    );
    expect(delivery.invalidatePackage).toHaveBeenCalledWith(5);
    expect(dispatcher.packagesChanged).toHaveBeenCalledWith([5]);
  });

  it('rewrites published revisions of dependents after confirmation', async () => {
    const { service, storage, dispatcher } = makeRenameService({
      dependents: [{ packageId: 9, roomId: 3, revision: 2 }],
      dependentRows: [{ id: 9, name: 'Level' }],
    });

    await expect(service.update(5, { slug: 'hero2' })).rejects.toMatchObject({
      response: {
        code: 'slug_in_use_by_dependents',
        reason: 'dependents',
        dependents: [{ packageId: 9, name: 'Level' }],
      },
    });
    expect(storage.rewriteRevision).not.toHaveBeenCalled();

    await service.update(5, {
      slug: 'hero2',
      confirmSlugRename: true,
      name: 'Hero',
    });

    expect(storage.rewriteRevision).toHaveBeenCalledWith(
      9,
      1,
      'published',
      expect.any(Function),
    );
    expect(dispatcher.packagesChanged).toHaveBeenCalledWith([5, 9]);
  });

  it('refuses to rename a global package', async () => {
    const { service } = makeRenameService({
      pkg: { id: 5, slug: 'hero', room: null },
    });

    await expect(service.update(5, { slug: 'hero2' })).rejects.toMatchObject({
      response: { code: 'slug_not_editable' },
    });
  });

  it('does not save anything when the target slug is taken', async () => {
    const { service, packages, storage } = makeRenameService({
      live: { id: 99, slug: 'taken' },
    });

    await expect(service.update(5, { slug: 'taken', name: 'New' })).rejects
      .toMatchObject({ response: { code: 'slug_taken' } });

    expect(packages.save).not.toHaveBeenCalled();
    expect(storage.rewriteRevision).not.toHaveBeenCalled();
  });

  it('is a no-op when the slug did not change', async () => {
    const { service, packages, storage } = makeRenameService();

    await service.update(5, { slug: 'hero', name: 'New' });

    expect(storage.rewriteRevision).not.toHaveBeenCalled();
    expect(packages.save).toHaveBeenCalled();
  });

  it('renames a package whose draft was never uploaded', async () => {
    const { service, storage } = makeRenameService({
      ownRevisions: [
        {
          id: 11,
          revision: 2,
          status: 'draft',
          files: [{ filepath: 'a.gd', size: 1, sha256: 'x' }],
        },
      ],
      rewrite: jest.fn(async () => null),
    });

    await expect(service.update(5, { slug: 'hero2' })).resolves.toMatchObject({
      slug: 'hero2',
    });

    expect(storage.rewriteRevision).toHaveBeenCalledWith(
      5,
      2,
      'draft',
      expect.any(Function),
    );
    expect(storage.abortRewrite).not.toHaveBeenCalled();
  });

  it('renames a package without any revisions', async () => {
    const { service, storage, dispatcher } = makeRenameService({
      ownRevisions: [],
    });

    await expect(service.update(5, { slug: 'hero2' })).resolves.toMatchObject({
      slug: 'hero2',
    });

    expect(storage.rewriteRevision).not.toHaveBeenCalled();
    expect(dispatcher.packagesChanged).not.toHaveBeenCalled();
  });

  it('allows a room slug that is already used by a workshop record', async () => {
    const { service, manager, packages } = makeRenameService();

    await service.update(5, { slug: 'taken' });

    expect(manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining('global'),
      expect.anything(),
    );
    expect(packages.save).toHaveBeenCalled();
  });

  it('takes the two slug locks in lexicographic order', async () => {
    const { service, manager } = makeRenameService();

    await service.update(5, { slug: 'aaa' });

    expect(
      manager.query.mock.calls
        .filter(([, params]) => Array.isArray(params))
        .map(([, params]) => (params as string[])[0]),
    ).toEqual(['package_slug:room:3:aaa', 'package_slug:room:3:hero']);
  });

  it('rolls the bytes back and reports slug_rewrite_failed', async () => {
    const { service, packages, storage } = makeRenameService({
      rewrite: jest.fn(async () => {
        throw new Error('disk');
      }),
    });

    await expect(service.update(5, { slug: 'hero2' })).rejects.toMatchObject({
      response: { code: 'slug_rewrite_failed' },
    });

    expect(packages.save).not.toHaveBeenCalled();
    expect(storage.abortRewrite).toHaveBeenCalledWith(5, 1, 'published');
  });

  it('saves metadata in the same update as a confirmed rename', async () => {
    const { service, packages } = makeRenameService();

    await service.update(5, {
      slug: 'hero2',
      name: 'H',
      version: '2.0',
      description: 'd',
      tags: ['a'],
    });

    const saved = packages.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      slug: 'hero2',
      name: 'H',
      version: '2.0',
      description: 'd',
      tags: ['a'],
    });
  });

  it('rewrites from the slug it re-reads inside the transaction', async () => {
    const { service, storage } = makeRenameService({
      self: { id: 5, slug: 'hero_old', name: 'Hero', room: { id: 3 } },
    });

    await service.update(5, { slug: 'hero2' });

    const transform = storage.rewriteRevision.mock.calls[0][3] as (
      filepath: string,
      data: Buffer,
    ) => Buffer;
    expect(
      transform('a.gd', Buffer.from('res://packages/hero_old/a.gd')).toString(),
    ).toBe('res://packages/hero2/a.gd');
  });

  it('applies only metadata when another request already used the target slug', async () => {
    const { service, storage, dispatcher, packages } = makeRenameService({
      self: { id: 5, slug: 'hero2', name: 'Hero', room: { id: 3 } },
    });

    await service.update(5, { slug: 'hero2', name: 'Fresh' });

    expect(storage.rewriteRevision).not.toHaveBeenCalled();
    expect(dispatcher.packagesChanged).not.toHaveBeenCalled();
    expect(packages.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Fresh', slug: 'hero2' }),
    );
  });
});
