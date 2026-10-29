import path from 'path';
import { BadRequestException } from '@nestjs/common';

export class PackagePathError extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'PackagePathError';
  }
}

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
// Control characters are rejected on purpose: they are never valid in a path
// and would produce confusing, unopenable files on the host file system.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validates a path declared by a package revision and returns its canonical
 * POSIX form. Package paths are always relative, always separated by `/`, and
 * can never leave the package directory.
 *
 * Rejected: absolute paths, drive letters, backslashes, `.`/`..` segments,
 * empty segments (`//`, leading/trailing slash), control characters and
 * segments that Windows would silently normalize (trailing dot or space),
 * because those create ambiguous duplicates on the host file system.
 */
export function normalizePackagePath(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new PackagePathError('Package file path must be a string');
  }
  const value = raw;
  if (value.length === 0) {
    throw new PackagePathError('Package file path must not be empty');
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new PackagePathError(
      `Package file path is longer than ${MAX_PATH_LENGTH} characters`,
    );
  }
  if (value.trim().length === 0) {
    throw new PackagePathError('Package file path must not be blank');
  }
  if (CONTROL_CHARS.test(value)) {
    throw new PackagePathError(
      'Package file path must not contain control characters',
    );
  }
  if (value.includes('\\')) {
    throw new PackagePathError(
      `Package file path must use "/" separators: ${value}`,
    );
  }
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith('~')
  ) {
    throw new PackagePathError(`Package file path must be relative: ${value}`);
  }

  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new PackagePathError(
        `Package file path must not contain empty segments: ${value}`,
      );
    }
    if (segment === '.' || segment === '..') {
      throw new PackagePathError(
        `Package file path must not contain "." or ".." segments: ${value}`,
      );
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new PackagePathError(
        `Package file path segment is longer than ${MAX_SEGMENT_LENGTH} characters`,
      );
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new PackagePathError(
        `Package file path segment ends with a dot or a space: ${value}`,
      );
    }
  }

  const normalized = segments.join('/');
  if (path.posix.normalize(normalized) !== normalized) {
    throw new PackagePathError(`Package file path is ambiguous: ${value}`);
  }
  return normalized;
}

/**
 * Normalizes every path of a manifest and rejects case-insensitive duplicates:
 * `Hero.png` and `hero.png` address the same file on Windows and macOS.
 */
export function normalizePackagePaths(rawPaths: unknown[]): string[] {
  const seen = new Map<string, string>();
  return rawPaths.map((raw) => {
    const normalized = normalizePackagePath(raw);
    const key = normalized.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new PackagePathError(
        `Duplicate package file path: ${previous} and ${normalized}`,
      );
    }
    seen.set(key, normalized);
    return normalized;
  });
}

/**
 * Directory names inside a package directory that belong to revision storage.
 * The legacy "upload a file into the package directory" API must never touch
 * them, otherwise it could read or overwrite draft/published revisions.
 */
const RESERVED_PACKAGE_SEGMENTS = ['drafts', 'revisions'];

/**
 * Validates a path passed to the legacy physical-file API. On top of ordinary
 * path safety it rejects the revision storage directories, so a published
 * revision stays immutable no matter which endpoint is used.
 */
export function assertLegacyPackagePath(raw: unknown): string {
  const normalized = normalizePackagePath(raw);
  const firstSegment = normalized.split('/')[0].toLowerCase();
  if (RESERVED_PACKAGE_SEGMENTS.includes(firstSegment)) {
    throw new PackagePathError(
      `Package file path uses a reserved directory: ${normalized}`,
    );
  }
  return normalized;
}

/**
 * Resolves a validated package-relative path under `rootDir` and asserts the
 * result stays inside it (defense in depth on top of `normalizePackagePath`).
 */
export function resolvePackagePath(
  rootDir: string,
  relativePath: string,
): string {
  const normalized = normalizePackagePath(relativePath);
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PackagePathError(
      `Package file path escapes the package directory: ${relativePath}`,
    );
  }
  return resolved;
}
