import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { RetiredPackageSlug } from 'src/database/entities/retired-package-slug.entity';
import { ScriptingPackagesService } from './scripting-packages.service';

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
    retiredFindOne?: jest.Mock;
    save?: jest.Mock;
    delete?: jest.Mock;
  } = {},
): FakeManager {
  const retiredFindOne = options.retiredFindOne ?? jest.fn(async () => null);
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
  manager.getRepository.mockImplementation((entity: unknown) => {
    if (entity === RetiredPackageSlug) {
      return { findOne: retiredFindOne };
    }
    return {
      create: (value: unknown) => value,
      findOne: manager.findOne,
      save: manager.save,
    };
  });
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
          storage as never,
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
          undefined,
          dispatcher as never,
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
          undefined,
          undefined,
          delivery as never,
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
      retiredFindOne?: jest.Mock;
      save?: jest.Mock;
      manager?: FakeManager;
      pkg?: unknown;
    } = {},
  ) {
    const retiredFindOne = options.retiredFindOne ?? jest.fn(async () => null);
    const manager =
      options.manager ??
      makeTransactionManager({ retiredFindOne, save: options.save });
    const packagesRepository = {
      query: options.query ?? jest.fn(async () => []),
      findOne:
        options.findOne ??
        jest.fn(async () => options.pkg ?? { id: 7, slug: 'hero' }),
      manager,
    };
    const roomsRepository = { findOne: jest.fn(async () => null) };
    const retiredRepository = { findOne: retiredFindOne };
    return new ScriptingPackagesService(
      packagesRepository as never,
      roomsRepository as never,
      undefined,
      undefined,
      undefined,
      undefined,
      retiredRepository as never,
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

  it('reports a live slug as taken', async () => {
    const service = makeSlugService({
      findOne: jest.fn(async () => ({ id: 7, slug: 'hero' })),
    });
    await expect(service.checkSlugAvailability('hero')).resolves.toEqual({
      slug: 'hero',
      available: false,
      reason: 'taken',
    });
  });

  it('reports a retired slug as retired', async () => {
    const service = makeSlugService({
      findOne: jest.fn(async () => null),
      retiredFindOne: jest.fn(async () => ({ slug: 'hero', packageId: 7 })),
    });
    await expect(service.checkSlugAvailability('hero')).resolves.toEqual({
      slug: 'hero',
      available: false,
      reason: 'retired',
    });
  });

  it('reports an unused slug as available', async () => {
    const service = makeSlugService({ findOne: jest.fn(async () => null) });
    await expect(service.checkSlugAvailability('  hero_2  ')).resolves.toEqual({
      slug: 'hero_2',
      available: true,
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

  it('rejects creation with a retired slug', async () => {
    const service = makeSlugService({
      retiredFindOne: jest.fn(async () => ({ slug: 'hero', packageId: 7 })),
    });
    await expect(
      service.create(
        { name: 'Hero', version: '0.1.0', slug: 'hero', authorId: 1 },
        { id: 1 } as never,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('maps a unique violation to slug_taken', async () => {
    const service = makeSlugService({
      save: jest.fn(async () => {
        throw { code: '23505' };
      }),
    });
    await expect(
      service.create(
        { name: 'Hero', version: '0.1.0', slug: 'hero', authorId: 1 },
        { id: 1 } as never,
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: 'slug_taken' } });
  });

  it('tombstones the slug before deleting the package', async () => {
    const manager = makeTransactionManager();
    const service = makeSlugService({ manager });
    await service.remove(7);
    expect(manager.save).toHaveBeenCalledWith(
      RetiredPackageSlug,
      expect.objectContaining({ slug: 'hero', packageId: 7 }),
    );
    expect(manager.delete).toHaveBeenCalledWith(ScriptingPackage, 7);
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
      undefined,
      undefined,
      revisionsRepository as never,
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
