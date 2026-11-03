import { extname } from 'node:path';

/** Files whose text may contain `res://packages/<slug>/` references. */
export const SLUG_REWRITE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.gd',
  '.tscn',
  '.tres',
  '.import',
]);

/**
 * Replaces whole-slug package references (`res://packages/<from>/`) with the
 * new slug. Only text resources are touched: rewriting a binary file would
 * corrupt it, and a reference that merely starts with the same characters
 * (`hero_2` for `hero`) is a different package.
 */
export function rewriteSlugReferences(
  filepath: string,
  data: Buffer,
  fromSlug: string,
  toSlug: string,
): Buffer {
  if (!SLUG_REWRITE_EXTENSIONS.has(extname(filepath).toLowerCase())) {
    return data;
  }
  const from = `res://packages/${fromSlug}/`;
  const text = data.toString('utf8');
  const next = text.split(from).join(`res://packages/${toSlug}/`);
  return next === text ? data : Buffer.from(next, 'utf8');
}
