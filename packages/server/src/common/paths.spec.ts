import path from 'path';
import {
  PathTraversalError,
  normalizeRelativePath,
  resolveWithin,
} from './paths';

describe('normalizeRelativePath', () => {
  it('keeps a well-formed relative path as typed', () => {
    expect(normalizeRelativePath('scripts/hero/hero.gd')).toBe(
      'scripts/hero/hero.gd',
    );
    expect(normalizeRelativePath('project.godot')).toBe('project.godot');
  });

  it('rejects anything that is not a string', () => {
    expect(() => normalizeRelativePath(42)).toThrow(PathTraversalError);
    expect(() => normalizeRelativePath(null)).toThrow('must be a string');
  });

  it.each([
    ['an empty path', ''],
    ['a blank path', '   '],
    ['a control character', 'scripts/he\u0000ro.gd'],
    ['a backslash separator', 'scripts\\hero.gd'],
    ['an absolute path', '/etc/passwd'],
    ['a drive letter', 'C:/Windows/System32'],
    ['a home shortcut', '~/secrets'],
    ['an empty segment', 'scripts//hero.gd'],
    ['a trailing slash', 'scripts/'],
    ['a dot segment', './project.godot'],
    ['a parent segment', 'scripts/../../etc/passwd'],
    ['a segment with a trailing dot', 'scripts/hero.'],
    ['a segment with a trailing space', 'scripts/hero '],
  ])('rejects %s', (_label, raw) => {
    expect(() => normalizeRelativePath(raw)).toThrow(PathTraversalError);
  });

  it('rejects an over-long path and an over-long segment', () => {
    expect(() => normalizeRelativePath('a'.repeat(1025))).toThrow(
      'longer than 1024',
    );
    expect(() => normalizeRelativePath(`a/${'b'.repeat(256)}`)).toThrow(
      'segment is longer than 255',
    );
  });
});

describe('resolveWithin', () => {
  const root = path.resolve('/tmp/wired-root');

  it('resolves a validated path under the root', () => {
    expect(resolveWithin(root, 'scripts/hero.gd')).toBe(
      path.join(root, 'scripts', 'hero.gd'),
    );
  });

  it('refuses a path that would leave the root', () => {
    expect(() => resolveWithin(root, '../outside.txt')).toThrow(
      PathTraversalError,
    );
  });

  it('reports traversal as a 400 so a caller can read the reason', () => {
    const error = (() => {
      try {
        resolveWithin(root, '../outside.txt');
      } catch (caught) {
        return caught as PathTraversalError;
      }
      return null;
    })();

    expect(error?.getStatus()).toBe(400);
    expect(error?.name).toBe('PathTraversalError');
  });
});
