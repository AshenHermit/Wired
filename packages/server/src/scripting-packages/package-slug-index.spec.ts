import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import {
  loadPackageSlugIndex,
  resolvePackageTarget,
  slugForPackage,
} from './package-slug-index';

/**
 * `Repository#find` returns full entities, so a `{ id, slug }` partial mock is
 * not structurally assignable. The cast keeps the production signature honest.
 */
function mockRepository(rows: Array<{ id: number; slug: string | null }>) {
  return {
    find: jest.fn(() => Promise.resolve(rows)),
  } as unknown as Pick<Repository<ScriptingPackage>, 'find'>;
}

describe('package slug index', () => {
  it('resolves digit-only targets as numeric ids', () => {
    const index = {
      bySlug: new Map([['42', 99]]),
      byId: new Map([[42, 'legacy']]),
    };
    expect(resolvePackageTarget('42', index)).toBe(42);
  });

  it('resolves non-numeric targets by slug', () => {
    const index = {
      bySlug: new Map([['hero_controller', 9]]),
      byId: new Map([[9, 'hero_controller']]),
    };
    expect(resolvePackageTarget('hero_controller', index)).toBe(9);
  });

  it('returns null for an unknown slug', () => {
    expect(
      resolvePackageTarget('missing', { bySlug: new Map(), byId: new Map() }),
    ).toBeNull();
  });

  it('loads id and slug maps from the repository', async () => {
    const repo = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: 1, slug: 'one' },
          { id: 2, slug: 'two' },
        ]),
      ),
    } as unknown as Pick<Repository<ScriptingPackage>, 'find'>;
    const index = await loadPackageSlugIndex(repo);
    expect(index.bySlug.get('two')).toBe(2);
    expect(index.byId.get(1)).toBe('one');
  });

  it('selects only the id and slug columns', async () => {
    const repo = {
      find: jest.fn(() => Promise.resolve([])),
    } as unknown as Pick<Repository<ScriptingPackage>, 'find'>;
    await loadPackageSlugIndex(repo);
    expect(repo.find).toHaveBeenCalledWith({
      select: { id: true, slug: true },
    });
  });

  it('skips packages without a slug', async () => {
    const repo = mockRepository([
      { id: 1, slug: 'one' },
      { id: 2, slug: null },
    ]);
    const index = await loadPackageSlugIndex(repo);
    expect(index.bySlug).toEqual(new Map([['one', 1]]));
    expect(index.byId).toEqual(new Map([[1, 'one']]));
  });

  it('returns the slug of a known package', () => {
    expect(
      slugForPackage(1, {
        bySlug: new Map([['one', 1]]),
        byId: new Map([[1, 'one']]),
      }),
    ).toBe('one');
  });

  it('throws for a package without a slug instead of falling back to its id', () => {
    expect(() =>
      slugForPackage(7, { bySlug: new Map(), byId: new Map() }),
    ).toThrow('package_slug_missing:7');
  });
});
