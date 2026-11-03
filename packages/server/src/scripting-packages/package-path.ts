import { PathTraversalError, normalizeRelativePath } from 'src/common/paths';

/**
 * Package-facing spellings of the shared path guards.
 *
 * The validators themselves live in `common/paths.ts`; this module only adds
 * the package-specific rule on top of them and keeps the package vocabulary at
 * the call sites that deal with manifests.
 */
export { PathTraversalError as PackagePathError };
export {
  normalizeRelativePath as normalizePackagePath,
  resolveWithin as resolvePackagePath,
} from 'src/common/paths';

/**
 * Normalizes every path of a manifest and rejects case-insensitive duplicates:
 * `Hero.png` and `hero.png` address the same file on Windows and macOS.
 */
export function normalizePackagePaths(rawPaths: unknown[]): string[] {
  const seen = new Map<string, string>();
  return rawPaths.map((raw) => {
    const normalized = normalizeRelativePath(raw);
    const key = normalized.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new PathTraversalError(
        `Duplicate package file path: ${previous} and ${normalized}`,
      );
    }
    seen.set(key, normalized);
    return normalized;
  });
}
