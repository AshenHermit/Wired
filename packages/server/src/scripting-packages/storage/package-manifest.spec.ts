import { BadRequestException } from '@nestjs/common';
import { validatePackageRevisionFiles } from './package-manifest';

const hash = 'a'.repeat(64);

describe('validatePackageRevisionFiles', () => {
  it('returns a canonical manifest for valid files', () => {
    const result = validatePackageRevisionFiles([
      { filepath: 'scenes/hero.tscn', size: 12, sha256: hash.toUpperCase() },
      { filepath: 'main.gd', size: 3, sha256: 'b'.repeat(64) },
    ]);

    expect(result).toEqual([
      { filepath: 'scenes/hero.tscn', size: 12, sha256: hash },
      { filepath: 'main.gd', size: 3, sha256: 'b'.repeat(64) },
    ]);
  });

  it.each([
    ['not an array', { filepath: 'a.tscn' }],
    ['an empty list', []],
    ['a non-object entry', ['a.tscn']],
    ['a missing filepath', [{ size: 1, sha256: hash }]],
    ['a non-string filepath', [{ filepath: 5, size: 1, sha256: hash }]],
    ['an unsafe filepath', [{ filepath: '../a.tscn', size: 1, sha256: hash }]],
    ['a negative size', [{ filepath: 'a.tscn', size: -1, sha256: hash }]],
    ['a fractional size', [{ filepath: 'a.tscn', size: 1.5, sha256: hash }]],
    ['a missing size', [{ filepath: 'a.tscn', sha256: hash }]],
    ['a short hash', [{ filepath: 'a.tscn', size: 1, sha256: 'abc' }]],
    ['a missing hash', [{ filepath: 'a.tscn', size: 1 }]],
    [
      'duplicate paths',
      [
        { filepath: 'Hero.png', size: 1, sha256: hash },
        { filepath: 'hero.png', size: 1, sha256: hash },
      ],
    ],
  ])('rejects %s', (_name, input) => {
    expect(() => validatePackageRevisionFiles(input)).toThrow(
      BadRequestException,
    );
  });

  it('rejects a file above the per-file limit', () => {
    expect(() =>
      validatePackageRevisionFiles([
        { filepath: 'big.pck', size: 64 * 1024 * 1024 + 1, sha256: hash },
      ]),
    ).toThrow(/too large/i);
  });

  it('rejects a manifest above the total size limit', () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      filepath: `part-${index}.bin`,
      size: 60 * 1024 * 1024,
      sha256: hash,
    }));

    expect(() => validatePackageRevisionFiles(files)).toThrow(/total/i);
  });

  it('rejects a manifest with too many files', () => {
    const files = Array.from({ length: 2001 }, (_, index) => ({
      filepath: `f-${index}.txt`,
      size: 0,
      sha256: hash,
    }));

    expect(() => validatePackageRevisionFiles(files)).toThrow(/too many/i);
  });
});
