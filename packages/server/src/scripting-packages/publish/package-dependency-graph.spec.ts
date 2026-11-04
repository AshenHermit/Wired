import {
  PinnedPackage,
  loadPinnedPackage,
  pinnedPackageLoader,
  walkPinnedClosure,
} from './package-dependency-graph';

/**
 * A pin graph as `packageId -> pinned dependency ids`, with revision 1 for every
 * package that has one. `null` means the package was never published.
 */
function graph(
  edges: Record<number, number[]>,
  unpublished: number[] = [],
): (packageId: number) => Promise<PinnedPackage> {
  return async (packageId) => {
    if (unpublished.includes(packageId)) {
      return { revision: null, pins: null };
    }
    const pins = edges[packageId];
    if (!pins) {
      // Published, but the revision pinned nothing.
      return { revision: 1, pins: null };
    }
    return { revision: 1, pins };
  };
}

describe('walkPinnedClosure', () => {
  it('returns the seeds before anything they reach', async () => {
    const order = await walkPinnedClosure([1], {
      load: graph({ 1: [2], 2: [3] }),
    });

    expect(order).toEqual([1, 2, 3]);
  });

  it('visits the nearest dependency first when two branches share a level', async () => {
    const order = await walkPinnedClosure([1], {
      load: graph({ 1: [2, 3], 2: [4], 3: [5] }),
    });

    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('enters a package once even when several packages depend on it', async () => {
    const order = await walkPinnedClosure([1], {
      load: graph({ 1: [2, 3], 2: [4], 3: [4] }),
    });

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('stops at a package with no published revision', async () => {
    const order = await walkPinnedClosure([1], {
      load: graph({ 1: [2], 2: [3] }, [2]),
    });

    expect(order).toEqual([1, 2]);
  });

  it('honours ids the caller already handled', async () => {
    const order = await walkPinnedClosure([1], {
      load: graph({ 1: [2] }),
      visited: new Set([2]),
    });

    expect(order).toEqual([1]);
  });

  it('extends the caller set instead of replacing it', async () => {
    const visited = new Set<number>([9]);

    await walkPinnedClosure([1], { load: graph({ 1: [2] }), visited });

    expect([...visited].sort((a, b) => a - b)).toEqual([1, 2, 9]);
  });

  it('leaves out a dependency the caller refuses', async () => {
    const order = await walkPinnedClosure([1], {
      load: graph({ 1: [2, 3], 2: [4] }),
      onDiscover: (packageId) => packageId !== 3,
    });

    expect(order).toEqual([1, 2, 4]);
  });

  it('does not enter a refused dependency and does not ask again', async () => {
    const load = jest.fn(graph({ 1: [2, 3], 3: [4] }));

    const order = await walkPinnedClosure([1], {
      load,
      onDiscover: (packageId) => packageId !== 3,
    });

    expect(order).toEqual([1, 2]);
    expect(load).not.toHaveBeenCalledWith(3);
    expect(load).not.toHaveBeenCalledWith(4);
  });

  it('propagates a refusal from onDiscover', async () => {
    await expect(
      walkPinnedClosure([1], {
        load: graph({ 1: [2] }),
        onDiscover: () => {
          throw new Error('dependency_disabled:2');
        },
      }),
    ).rejects.toThrow('dependency_disabled:2');
  });
});

describe('loadPinnedPackage', () => {
  it('reports no revision when the package was never published', async () => {
    const deps = {
      latestPublished: jest.fn(async () => null),
      readPinnedDependencies: jest.fn(async () => new Map([[2, 1]])),
    };

    await expect(loadPinnedPackage(deps, 5)).resolves.toEqual({
      revision: null,
      pins: null,
    });
    expect(deps.readPinnedDependencies).not.toHaveBeenCalled();
  });

  it('reads the pins recorded by the latest published revision', async () => {
    const deps = {
      latestPublished: jest.fn(async () => ({ revision: 7 })),
      readPinnedDependencies: jest.fn(
        async () =>
          new Map([
            [2, 1],
            [3, 2],
          ]),
      ),
    };

    await expect(loadPinnedPackage(deps, 5)).resolves.toEqual({
      revision: 7,
      pins: [2, 3],
    });
    expect(deps.readPinnedDependencies).toHaveBeenCalledWith(5, 7);
  });

  it('reports no pins when the revision recorded none', async () => {
    const deps = {
      latestPublished: jest.fn(async () => ({ revision: 7 })),
      readPinnedDependencies: jest.fn(async () => null),
    };

    await expect(loadPinnedPackage(deps, 5)).resolves.toEqual({
      revision: 7,
      pins: null,
    });
  });
});

describe('pinnedPackageLoader', () => {
  it('asks for the newest published revision of the package', async () => {
    const findOne = jest.fn(async () => ({ revision: 4 }));
    const readPinnedDependencies = jest.fn(async () => null);

    await pinnedPackageLoader({ findOne } as never, {
      readPinnedDependencies,
    })(5);

    expect(findOne).toHaveBeenCalledWith({
      where: { package: { id: 5 }, status: 'published' },
      order: { revision: 'DESC' },
    });
    expect(readPinnedDependencies).toHaveBeenCalledWith(5, 4);
  });
});
