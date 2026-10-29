import {
  PackagePathError,
  normalizePackagePath,
  normalizePackagePaths,
  resolvePackagePath,
} from './package-path';
import { BadRequestException } from '@nestjs/common';

const root = process.platform === 'win32' ? 'C:\\root\\pkg' : '/root/pkg';

describe('PackagePathError', () => {
  it('surfaces as an HTTP 400 so it cannot leak as a server error', () => {
    expect(new PackagePathError('bad path')).toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('normalizePackagePath', () => {
  it('keeps flat and nested relative paths', () => {
    expect(normalizePackagePath('main.tscn')).toBe('main.tscn');
    expect(normalizePackagePath('scenes/hero.tscn')).toBe('scenes/hero.tscn');
    expect(normalizePackagePath('assets/sprites/hero idle.png')).toBe(
      'assets/sprites/hero idle.png',
    );
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['absolute posix', '/etc/passwd'],
    ['absolute windows', 'C:/windows/system32'],
    ['traversal segment', 'a/../../etc/passwd'],
    ['leading traversal', '../secret.txt'],
    ['dot segment', './main.tscn'],
    ['inner dot segment', 'a/./b.tscn'],
    ['backslash separator', 'a\\b.tscn'],
    ['trailing separator', 'a/'],
    ['double separator', 'a//b.tscn'],
    ['nul byte', 'a/\u0000b.tscn'],
    ['control character', 'a/\u0007b.tscn'],
    ['trailing dot segment', 'a/b.'],
    ['trailing space segment', 'a /b.tscn'],
  ])('rejects an %s', (_name, value) => {
    expect(() => normalizePackagePath(value)).toThrow(PackagePathError);
  });

  it('rejects non-string input and overlong segments', () => {
    expect(() => normalizePackagePath(42 as unknown as string)).toThrow(
      PackagePathError,
    );
    expect(() => normalizePackagePath('a/' + 'x'.repeat(256))).toThrow(
      PackagePathError,
    );
  });
});

describe('normalizePackagePaths', () => {
  it('normalizes a list and rejects ambiguous case-insensitive duplicates', () => {
    expect(normalizePackagePaths(['a/b.tscn', 'c.tscn'])).toEqual([
      'a/b.tscn',
      'c.tscn',
    ]);
    expect(() => normalizePackagePaths(['Hero.png', 'hero.png'])).toThrow(
      /duplicate/i,
    );
    expect(() => normalizePackagePaths(['a/b.tscn', 'a\\b.tscn'])).toThrow(
      PackagePathError,
    );
  });
});

describe('resolvePackagePath', () => {
  it('resolves inside the package directory', () => {
    const resolved = resolvePackagePath(root, 'scenes/hero.tscn');
    expect(resolved.startsWith(root)).toBe(true);
    expect(resolved.endsWith('hero.tscn')).toBe(true);
  });

  it('never resolves outside the package directory', () => {
    expect(() => resolvePackagePath(root, '../outside.txt')).toThrow(
      PackagePathError,
    );
    expect(() => resolvePackagePath(root, 'a/../../outside.txt')).toThrow(
      PackagePathError,
    );
  });
});
