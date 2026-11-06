import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import {
  loadPackageSlugIndex,
  PackageSlugIndex,
  resolvePackageTarget,
  slugForPackage,
} from './package-slug-index';

/** One room package and one global package share `hero`; `lib` is global only. */
const index: PackageSlugIndex = {
  byId: new Map([
    [1, { slug: 'hero', roomId: 5 }],
    [2, { slug: 'hero', roomId: 6 }],
    [3, { slug: 'hero', roomId: null }],
    [4, { slug: 'lib', roomId: null }],
  ]),
  byRoomSlug: new Map([
    ['5:hero', 1],
    ['6:hero', 2],
  ]),
  byGlobalSlug: new Map([
    ['hero', 3],
    ['lib', 4],
  ]),
};

describe('package slug index', () => {
  it('prefers the room package over a global one with the same slug', () => {
    expect(resolvePackageTarget('hero', index, 5)).toBe(1);
    expect(resolvePackageTarget('hero', index, 6)).toBe(2);
  });

  it('does not resolve another room package', () => {
    expect(resolvePackageTarget('hero', index, 7)).toBe(3);
  });

  it('resolves a global slug when the room has no such slug', () => {
    expect(resolvePackageTarget('lib', index, 5)).toBe(4);
  });

  it('resolves only global slugs without a room', () => {
    expect(resolvePackageTarget('hero', index, null)).toBe(3);
  });

  it('keeps numeric targets as ids', () => {
    expect(resolvePackageTarget('42', index, 5)).toBe(42);
  });

  it('returns null for an unknown slug', () => {
    expect(resolvePackageTarget('missing', index, 5)).toBeNull();
  });

  it('loads the room id for every row', async () => {
    const repo = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: 1, slug: 'hero', room: { id: 5 } },
          { id: 2, slug: 'lib', room: null },
        ]),
      ),
    };
    const loaded = await loadPackageSlugIndex(repo as never);
    expect(loaded.byId.get(1)).toEqual({ slug: 'hero', roomId: 5 });
    expect(loaded.byRoomSlug.get('5:hero')).toBe(1);
    expect(loaded.byGlobalSlug.get('lib')).toBe(2);
  });

  it('loads the room relation with the id and slug columns', async () => {
    const repo = { find: jest.fn(() => Promise.resolve([])) };
    await loadPackageSlugIndex(repo as never);
    expect(repo.find).toHaveBeenCalledWith({
      select: { id: true, slug: true },
      relations: { room: true },
    });
  });

  it('skips packages without a slug', async () => {
    const repo = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: 1, slug: 'one', room: null },
          { id: 2, slug: null, room: { id: 5 } },
        ]),
      ),
    };
    const loaded = await loadPackageSlugIndex(
      repo as unknown as Pick<Repository<ScriptingPackage>, 'find'>,
    );
    expect(loaded.byId).toEqual(new Map([[1, { slug: 'one', roomId: null }]]));
    expect(loaded.byRoomSlug).toEqual(new Map());
    expect(loaded.byGlobalSlug).toEqual(new Map([['one', 1]]));
  });

  it('returns the slug of a known package', () => {
    expect(slugForPackage(1, index)).toBe('hero');
  });

  it('throws for a package without a slug instead of falling back to its id', () => {
    expect(() => slugForPackage(7, index)).toThrow('package_slug_missing:7');
  });
});
