import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';

/**
 * Package slugs in both directions: `slug -> id` resolves a reference written
 * with a slug, `id -> slug` gives the path alias of a known package.
 *
 * Slugs are unique per room and per global scope, so a slug resolves
 * room-first and then globally ({@link resolvePackageTarget}).
 */
export interface PackageSlugIndex {
  byId: Map<number, { slug: string; roomId: number | null }>;
  byRoomSlug: Map<string, number>;
  byGlobalSlug: Map<string, number>;
}

/** Only a digit-only reference target addresses a package by numeric id. */
const NUMERIC_TARGET_RE = /^\d+$/;

/** A room-scoped slug key; room ids are integers, so `:` cannot collide. */
function roomSlugKey(roomId: number, slug: string): string {
  return `${roomId}:${slug}`;
}

/**
 * Loads the scoped `slug -> id` index in one query. Slugs are nullable only
 * during the startup backfill; a slugless row is skipped rather than guessed,
 * because paths must never fall back to `String(id)`.
 */
export async function loadPackageSlugIndex(
  repository: Pick<Repository<ScriptingPackage>, 'find'>,
): Promise<PackageSlugIndex> {
  const rows: Array<{
    id: number;
    slug: string | null;
    room?: { id: number } | null;
  }> = await repository.find({
    select: { id: true, slug: true },
    relations: { room: true },
  });

  const byId = new Map<number, { slug: string; roomId: number | null }>();
  const byRoomSlug = new Map<string, number>();
  const byGlobalSlug = new Map<string, number>();
  for (const row of rows) {
    if (row.slug === null || row.slug === undefined) {
      continue;
    }
    const roomId = row.room?.id ?? null;
    byId.set(row.id, { slug: row.slug, roomId });
    if (roomId === null) {
      byGlobalSlug.set(row.slug, row.id);
    } else {
      byRoomSlug.set(roomSlugKey(roomId, row.slug), row.id);
    }
  }
  return { byId, byRoomSlug, byGlobalSlug };
}

/**
 * Resolves a raw reference target to a package id: a digit-only target is a
 * numeric id, anything else is a slug. A slug is resolved in the referencing
 * room first, then in the global scope; another room's package is never
 * visible. A legacy numeric slug (`"7"`) therefore means id 7, which is the
 * same package.
 */
export function resolvePackageTarget(
  target: string,
  index: PackageSlugIndex,
  roomId: number | null,
): number | null {
  if (NUMERIC_TARGET_RE.test(target)) {
    return Number(target);
  }
  if (roomId !== null) {
    const roomScoped = index.byRoomSlug.get(roomSlugKey(roomId, target));
    if (roomScoped !== undefined) {
      return roomScoped;
    }
  }
  return index.byGlobalSlug.get(target) ?? null;
}

/**
 * The slug of a stored package, for payloads whose contract says `string`.
 *
 * `slug` is nullable in the database because rows written before slugs existed
 * carry NULL until the startup backfill runs, and the app refuses to boot if
 * one survives it. Throwing here keeps that guarantee visible at each wire
 * boundary instead of letting `null` into a field typed as a string.
 */
export function requirePackageSlug(pkg: {
  id: number;
  slug: string | null;
}): string {
  if (pkg.slug === null || pkg.slug === '') {
    throw new Error(`package_slug_missing:${pkg.id}`);
  }
  return pkg.slug;
}

/**
 * Returns the slug of a package. Throws instead of falling back to the numeric
 * id: a missing slug means the index was loaded before the backfill finished,
 * and a guessed path would point at a package that does not exist.
 */
export function slugForPackage(
  packageId: number,
  index: PackageSlugIndex,
): string {
  const entry = index.byId.get(packageId);
  if (entry === undefined) {
    throw new Error(`package_slug_missing:${packageId}`);
  }
  return entry.slug;
}
