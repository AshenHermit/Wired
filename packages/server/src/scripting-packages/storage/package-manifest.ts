import { BadRequestException } from '@nestjs/common';
import { PackageFileEntry } from '@wired-io/shared';
import { normalizePackagePaths } from './package-path';
import { normalizeSha256 } from './package-hash';

export const MAX_PACKAGE_FILES = 2000;
export const MAX_PACKAGE_FILE_SIZE = 64 * 1024 * 1024;
export const MAX_PACKAGE_TOTAL_SIZE = 256 * 1024 * 1024;

function fail(message: string): never {
  throw new BadRequestException(message);
}

function requireArray(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) {
    fail('files must be an array');
  }
  return raw;
}

/**
 * Validates the manifest a client declares before uploading a revision.
 * The manifest is authoritative: a revision is published only when every
 * declared file is present with the declared size and sha256.
 */
export function validatePackageRevisionFiles(raw: unknown): PackageFileEntry[] {
  const candidates = requireArray(raw);
  if (candidates.length === 0) {
    fail('A revision must declare at least one file');
  }
  if (candidates.length > MAX_PACKAGE_FILES) {
    fail(`Too many files in a revision (limit ${MAX_PACKAGE_FILES})`);
  }

  const entries = candidates.map((candidate, index): PackageFileEntry => {
    if (typeof candidate !== 'object' || candidate === null) {
      fail(`files[${index}] must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    const { filepath, size, sha256 } = record;
    if (typeof filepath !== 'string') {
      fail(`files[${index}].filepath must be a string`);
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      fail(`files[${index}].size must be a non-negative integer`);
    }
    if (size > MAX_PACKAGE_FILE_SIZE) {
      fail(
        `files[${index}] is too large (limit ${MAX_PACKAGE_FILE_SIZE} bytes)`,
      );
    }
    let normalizedSha256: string;
    try {
      normalizedSha256 = normalizeSha256(sha256);
    } catch {
      fail(`files[${index}].sha256 must be a sha256 hex digest`);
    }
    return {
      filepath,
      size,
      sha256: normalizedSha256,
    };
  });

  let paths: string[];
  try {
    paths = normalizePackagePaths(entries.map((entry) => entry.filepath));
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid package file path');
  }

  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalSize > MAX_PACKAGE_TOTAL_SIZE) {
    fail(
      `Package total size is too large (limit ${MAX_PACKAGE_TOTAL_SIZE} bytes)`,
    );
  }

  return entries.map((entry, index) => ({
    ...entry,
    filepath: paths[index],
  }));
}
