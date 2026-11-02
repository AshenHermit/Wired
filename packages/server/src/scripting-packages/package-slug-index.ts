import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';

/**
 * Package slugs in both directions: `slug -> id` resolves a reference written
 * with a slug, `id -> slug` gives the path alias of a known package.
 */
export interface PackageSlugIndex {
  bySlug: Map<string, number>;
  byId: Map<number, string>;
}

/** Only a digit-only reference target addresses a package by numeric id. */
const NUMERIC_TARGET_RE = /^\d+$/;

/**
 * Loads the global `slug <-> id` index in one query. Slugs are nullable only
 * during the startup backfill; a slugless row is skipped rather than guessed,
 * because paths must never fall back to `String(id)`.
 */
export async function loadPackageSlugIndex(
  repository: Pick<Repository<ScriptingPackage>, 'find'>,
): Promise<PackageSlugIndex> {
  const rows: Array<{ id: number; slug: string | null }> =
    await repository.find({ select: { id: true, slug: true } });

  const bySlug = new Map<string, number>();
  const byId = new Map<number, string>();
  for (const row of rows) {
    if (row.slug === null || row.slug === undefined) {
      continue;
    }
    bySlug.set(row.slug, row.id);
    byId.set(row.id, row.slug);
  }
  return { bySlug, byId };
}

/**
 * Resolves a raw reference target to a package id: a digit-only target is a
 * numeric id, anything else is a slug. A legacy numeric slug (`"7"`) therefore
 * means id 7, which is the same package.
 */
export function resolvePackageTarget(
  target: string,
  index: PackageSlugIndex,
): number | null {
  if (NUMERIC_TARGET_RE.test(target)) {
    return Number(target);
  }
  return index.bySlug.get(target) ?? null;
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
  const slug = index.byId.get(packageId);
  if (slug === undefined) {
    throw new Error(`package_slug_missing:${packageId}`);
  }
  return slug;
}
