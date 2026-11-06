import path from 'path';
import { BadRequestException } from '@nestjs/common';

/**
 * A path that cannot safely address a file inside a directory.
 *
 * Shared because more than one feature validates untrusted relative paths, and
 * each of them wants the rejection to surface as a 400 with a readable reason.
 */
export class PathTraversalError extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
// Control characters are rejected on purpose: they are never valid in a path
// and would produce confusing, unopenable files on the host file system.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validates a relative path a client declared and returns its canonical POSIX
 * form: always relative, always separated by `/`, never able to leave the
 * directory it is resolved under.
 *
 * Rejected: absolute paths, drive letters, backslashes, `.`/`..` segments,
 * empty segments (`//`, leading/trailing slash), control characters and
 * segments that Windows would silently normalize (trailing dot or space),
 * because those create ambiguous duplicates on the host file system.
 */
export function normalizeRelativePath(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new PathTraversalError('File path must be a string');
  }
  const value = raw;
  if (value.length === 0) {
    throw new PathTraversalError('File path must not be empty');
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new PathTraversalError(
      `File path is longer than ${MAX_PATH_LENGTH} characters`,
    );
  }
  if (value.trim().length === 0) {
    throw new PathTraversalError('File path must not be blank');
  }
  if (CONTROL_CHARS.test(value)) {
    throw new PathTraversalError(
      'File path must not contain control characters',
    );
  }
  if (value.includes('\\')) {
    throw new PathTraversalError(`File path must use "/" separators: ${value}`);
  }
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith('~')
  ) {
    throw new PathTraversalError(`File path must be relative: ${value}`);
  }

  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new PathTraversalError(
        `File path must not contain empty segments: ${value}`,
      );
    }
    if (segment === '.' || segment === '..') {
      throw new PathTraversalError(
        `File path must not contain "." or ".." segments: ${value}`,
      );
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new PathTraversalError(
        `File path segment is longer than ${MAX_SEGMENT_LENGTH} characters`,
      );
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new PathTraversalError(
        `File path segment ends with a dot or a space: ${value}`,
      );
    }
  }

  const normalized = segments.join('/');
  if (path.posix.normalize(normalized) !== normalized) {
    throw new PathTraversalError(`File path is ambiguous: ${value}`);
  }
  return normalized;
}

/**
 * Resolves a validated relative path under `rootDir` and asserts the result
 * stays inside it (defense in depth on top of `normalizeRelativePath`).
 */
export function resolveWithin(rootDir: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathTraversalError(
      `File path escapes the target directory: ${relativePath}`,
    );
  }
  return resolved;
}
