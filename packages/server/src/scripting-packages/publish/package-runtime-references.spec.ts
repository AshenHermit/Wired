import type { PackageSlugIndex } from '../storage/package-slug-index';
import {
  assertUniquePackageSlugs,
  buildSceneDependencies,
  collectRawPackageReferences,
  decodePackageText,
  isTextPackageFile,
  resolvePackageReferences,
  rewritePackageReferences,
  stripExtResourceUids,
} from './package-runtime-references';

const slugIndex: PackageSlugIndex = {
  byId: new Map([[9, { slug: 'hero', roomId: null }]]),
  byRoomSlug: new Map(),
  byGlobalSlug: new Map([['hero', 9]]),
};

/** Collects and resolves references the way every production caller does. */
const collect = (text: string) =>
  resolvePackageReferences(collectRawPackageReferences(text), slugIndex, 5)
    .resolved;

describe('package runtime references', () => {
  it('collects absolute package references', () => {
    expect(
      collect(
        'const A = preload("res://packages/5/lib/a.gd")\n' +
          '[ext_resource path="res://packages/6/tex.png" type="Texture2D"]',
      ),
    ).toEqual([
      { packageId: 5, filepath: 'lib/a.gd' },
      { packageId: 6, filepath: 'tex.png' },
    ]);
  });

  it('ignores package references on whole-line comments', () => {
    expect(
      collect(
        '# const OLD = preload("res://packages/99/a.gd")\n' +
          '  ; path="res://packages/98/b.gd"\n' +
          '## res://packages/97/c.gd\n' +
          'const A = preload("res://packages/5/a.gd")',
      ),
    ).toEqual([{ packageId: 5, filepath: 'a.gd' }]);
  });

  it('parses quoted references inside multi-line strings', () => {
    // Documented limitation: a quoted package path inside a multi-line string
    // is still a reference, because it is indistinguishable from code here.
    const text = 'var note = """see "res://packages/5/a.gd" """';
    expect(collect(text)).toEqual([{ packageId: 5, filepath: 'a.gd' }]);
  });

  it('deduplicates repeated package references', () => {
    expect(
      collect(
        'preload("res://packages/5/a.gd") + preload("res://packages/5/a.gd")',
      ),
    ).toEqual([{ packageId: 5, filepath: 'a.gd' }]);
  });

  it('collects a slug reference as a raw target', () => {
    expect(
      collectRawPackageReferences('path="res://packages/hero/scene.tscn"'),
    ).toEqual([{ target: 'hero', filepath: 'scene.tscn' }]);
  });

  it('collects a legacy numeric reference as a raw target', () => {
    expect(
      collectRawPackageReferences('path="res://packages/42/scene.tscn"'),
    ).toEqual([{ target: '42', filepath: 'scene.tscn' }]);
  });

  it('rejects uppercase and hyphenated targets', () => {
    expect(
      collectRawPackageReferences('path="res://packages/Hero/scene.tscn"'),
    ).toEqual([]);
    expect(
      collectRawPackageReferences('path="res://packages/hero-one/scene.tscn"'),
    ).toEqual([]);
  });

  it('rejects raw targets longer than 64 characters', () => {
    const target = 'a'.repeat(65);
    expect(
      collectRawPackageReferences(`path="res://packages/${target}/scene.tscn"`),
    ).toEqual([]);
  });

  it('deduplicates raw references by target and filepath', () => {
    expect(
      collectRawPackageReferences(
        'preload("res://packages/hero/a.gd") + ' +
          'preload("res://packages/hero/a.gd") + ' +
          'preload("res://packages/42/a.gd")',
      ),
    ).toEqual([
      { target: 'hero', filepath: 'a.gd' },
      { target: '42', filepath: 'a.gd' },
    ]);
  });

  it('ignores raw references on whole-line comments', () => {
    expect(
      collectRawPackageReferences(
        '# preload("res://packages/hero/a.gd")\n' +
          'const A = preload("res://packages/42/b.gd")',
      ),
    ).toEqual([{ target: '42', filepath: 'b.gd' }]);
  });

  it('rejects unsafe raw reference paths', () => {
    expect(() =>
      collectRawPackageReferences('preload("res://packages/hero/../b.gd")'),
    ).toThrow('package_reference_invalid_path:../b.gd');
    expect(() =>
      collectRawPackageReferences('preload("res://packages/hero/a\\b.gd")'),
    ).toThrow('package_reference_invalid_path:a\\b.gd');
  });

  it('resolves raw references by numeric id or slug', () => {
    expect(
      resolvePackageReferences(
        [
          { target: 'hero', filepath: 'scene.tscn' },
          { target: '42', filepath: 'legacy.tscn' },
        ],
        slugIndex,
        5,
      ),
    ).toEqual({
      resolved: [
        { packageId: 9, filepath: 'scene.tscn' },
        { packageId: 42, filepath: 'legacy.tscn' },
      ],
      unknown: [],
    });
  });

  it('resolves a reference in the room namespace first', () => {
    const index: PackageSlugIndex = {
      byId: new Map(),
      byRoomSlug: new Map([['5:hero', 1]]),
      byGlobalSlug: new Map([['hero', 3]]),
    };
    expect(
      resolvePackageReferences(
        collectRawPackageReferences('preload("res://packages/hero/main.gd")'),
        index,
        5,
      ).resolved,
    ).toEqual([{ packageId: 1, filepath: 'main.gd' }]);
    expect(
      resolvePackageReferences(
        collectRawPackageReferences('preload("res://packages/hero/main.gd")'),
        index,
        6,
      ).resolved,
    ).toEqual([{ packageId: 3, filepath: 'main.gd' }]);
  });

  it('reports unknown slugs without dropping known references', () => {
    expect(
      resolvePackageReferences(
        [
          { target: 'hero', filepath: 'a.tscn' },
          { target: 'missing', filepath: 'b.tscn' },
          { target: 'missing', filepath: 'c.tscn' },
        ],
        slugIndex,
        5,
      ),
    ).toEqual({
      resolved: [{ packageId: 9, filepath: 'a.tscn' }],
      unknown: ['missing'],
    });
  });

  it('deduplicates references that resolve to the same package file', () => {
    expect(
      resolvePackageReferences(
        [
          { target: 'hero', filepath: 'a.tscn' },
          { target: '9', filepath: 'a.tscn' },
        ],
        slugIndex,
        5,
      ),
    ).toEqual({
      resolved: [{ packageId: 9, filepath: 'a.tscn' }],
      unknown: [],
    });
  });

  it('recognizes editor text files case-insensitively', () => {
    expect(isTextPackageFile('main.tscn')).toBe(true);
    expect(isTextPackageFile('data/Material.TRES')).toBe(true);
    expect(isTextPackageFile('scripts/hero.GD')).toBe(true);
    expect(isTextPackageFile('tex.png')).toBe(false);
    expect(isTextPackageFile('sound.ogg')).toBe(false);
  });

  it('rewrites every package prefix to the artifact-keyed runtime location', () => {
    const revisions = new Map([
      [5, 3],
      [6, 9],
    ]);
    const keys = new Map([
      [5, 'k5'],
      [6, 'k6'],
    ]);
    expect(
      rewritePackageReferences(
        'preload("res://packages/5/lib/a.gd") + "res://packages/6/tex.png"',
        {
          roomId: 7,
          revisionByPackage: revisions,
          artifactKeyByPackage: keys,
          slugByPackage: new Map([
            [5, 'hero'],
            [6, 'library'],
          ]),
        },
      ),
    ).toBe(
      'preload("user://wired/rooms/7/packages/hero/3-k5/lib/a.gd") + ' +
        '"user://wired/rooms/7/packages/library/9-k6/tex.png"',
    );
  });

  it('rewrites references inside the artifact room namespace', () => {
    const text = 'const X = preload("res://packages/hero/main.gd")';
    const rewritten = rewritePackageReferences(text, {
      roomId: 5,
      revisionByPackage: new Map([[1, 2]]),
      artifactKeyByPackage: new Map([[1, 'abc']]),
      slugByPackage: new Map([[1, 'hero']]),
    });
    expect(rewritten).toContain(
      'user://wired/rooms/5/packages/hero/2-abc/main.gd',
    );
  });

  it('rewrites only quoted references, leaving comment text alone', () => {
    const revisions = new Map([[5, 3]]);
    const keys = new Map([[5, 'k5']]);
    const text =
      '# preload("res://packages/99/foo.gd")\n' +
      'const A = preload("res://packages/5/a.gd")';
    expect(
      rewritePackageReferences(text, {
        roomId: 7,
        revisionByPackage: revisions,
        artifactKeyByPackage: keys,
        slugByPackage: new Map([[5, 'hero']]),
      }),
    ).toBe(
      '# preload("res://packages/99/foo.gd")\n' +
        'const A = preload("user://wired/rooms/7/packages/hero/3-k5/a.gd")',
    );
  });

  it('does not fail on a commented reference to an unknown package', () => {
    const revisions = new Map([[5, 3]]);
    const keys = new Map([[5, 'k5']]);
    expect(
      rewritePackageReferences(
        '; path="res://packages/99/missing.gd"\n' +
          'preload("res://packages/5/a.gd")',
        {
          roomId: 7,
          revisionByPackage: revisions,
          artifactKeyByPackage: keys,
          slugByPackage: new Map([[5, 'hero']]),
        },
      ),
    ).toBe(
      '; path="res://packages/99/missing.gd"\n' +
        'preload("user://wired/rooms/7/packages/hero/3-k5/a.gd")',
    );
  });

  it('throws when a quoted reference has no pinned revision', () => {
    const revisions = new Map([[5, 3]]);
    const keys = new Map([[5, 'k5']]);
    expect(() =>
      rewritePackageReferences('preload("res://packages/99/a.gd")', {
        roomId: 7,
        revisionByPackage: revisions,
        artifactKeyByPackage: keys,
        slugByPackage: new Map([[5, 'hero']]),
      }),
    ).toThrow('package_reference_not_rewritable:99');
  });

  it('throws when a quoted reference has no slug', () => {
    expect(() =>
      rewritePackageReferences('preload("res://packages/5/a.gd")', {
        roomId: 7,
        revisionByPackage: new Map([[5, 3]]),
        artifactKeyByPackage: new Map([[5, 'k5']]),
        slugByPackage: new Map(),
      }),
    ).toThrow('package_reference_not_rewritable:5');
  });

  it('rewrites a reference into the slug runtime directory', () => {
    const text = 'path="res://packages/42/scene.tscn"';
    const rewritten = rewritePackageReferences(text, {
      roomId: 3,
      revisionByPackage: new Map([[42, 2]]),
      artifactKeyByPackage: new Map([[42, 'a'.repeat(64)]]),
      slugByPackage: new Map([[42, 'hero']]),
    });
    expect(rewritten).toContain(
      `user://wired/rooms/3/packages/hero/2-${'a'.repeat(64)}/scene.tscn`,
    );
  });

  it('rewrites a reference authored with a slug', () => {
    expect(
      rewritePackageReferences(
        'const Lib = preload("res://packages/library/lib/a.gd")',
        {
          roomId: 7,
          revisionByPackage: new Map([[6, 9]]),
          artifactKeyByPackage: new Map([[6, 'k6']]),
          slugByPackage: new Map([[6, 'library']]),
        },
      ),
    ).toBe(
      'const Lib = preload("user://wired/rooms/7/packages/library/9-k6/lib/a.gd")',
    );
  });

  it('rejects reference paths with backslash separators', () => {
    // Godot always addresses package files with `/`; a `\` is a Windows path
    // that would escape the artifact layout or silently address another file.
    expect(() => collect('preload("res://packages/5/a\\b.gd")')).toThrow(
      'package_reference_invalid_path:a\\b.gd',
    );
    expect(() => collect('preload("res://packages/5/a\\\\b.gd")')).toThrow(
      'package_reference_invalid_path:a\\\\b.gd',
    );
    expect(() => collect('preload("res://packages/5/..\\\\6/x.gd")')).toThrow(
      'package_reference_invalid_path',
    );
  });

  it('rewritePackageReferences rejects backslash separators', () => {
    const revisions = new Map([[5, 3]]);
    const keys = new Map([[5, 'k5']]);
    expect(() =>
      rewritePackageReferences('preload("res://packages/5/a\\b.gd")', {
        roomId: 7,
        revisionByPackage: revisions,
        artifactKeyByPackage: keys,
        slugByPackage: new Map([[5, 'hero']]),
      }),
    ).toThrow('package_reference_invalid_path:a\\b.gd');
  });

  it('rejects reference paths containing a "." or ".." segment', () => {
    expect(() => collect('preload("res://packages/5/./hero.gd")')).toThrow(
      'package_reference_invalid_path:./hero.gd',
    );
    expect(() => collect('preload("res://packages/5/a/../b.gd")')).toThrow(
      'package_reference_invalid_path:a/../b.gd',
    );
    expect(() => collect('preload("res://packages/5/../6/x")')).toThrow(
      'package_reference_invalid_path:../6/x',
    );
  });

  it('rewritePackageReferences rejects the same unsafe paths', () => {
    const revisions = new Map([[5, 3]]);
    const keys = new Map([[5, 'k5']]);
    const slugByPackage = new Map([[5, 'hero']]);
    expect(() =>
      rewritePackageReferences('preload("res://packages/5/./hero.gd")', {
        roomId: 7,
        revisionByPackage: revisions,
        artifactKeyByPackage: keys,
        slugByPackage,
      }),
    ).toThrow('package_reference_invalid_path:./hero.gd');
    expect(() =>
      rewritePackageReferences('preload("res://packages/5/a/../b.gd")', {
        roomId: 7,
        revisionByPackage: revisions,
        artifactKeyByPackage: keys,
        slugByPackage,
      }),
    ).toThrow('package_reference_invalid_path:a/../b.gd');
  });

  it('rejects two packages with the same slug in one closure', () => {
    expect(() =>
      assertUniquePackageSlugs(
        new Map([
          [1, 'hero'],
          [3, 'hero'],
        ]),
      ),
    ).toThrow('package_slug_shadowed:hero');
  });

  it('accepts distinct slugs in one closure', () => {
    expect(() =>
      assertUniquePackageSlugs(
        new Map([
          [1, 'hero'],
          [3, 'lib'],
        ]),
      ),
    ).not.toThrow();
  });

  it('strips uid only from ext_resource lines', () => {
    const text =
      '[gd_scene load_steps=2 format=3 uid="uid://scene"]\n' +
      '[ext_resource type="Script" uid="uid://script" path="a.gd" id="1"]\n';
    const rewritten = stripExtResourceUids('main.tscn', text);
    expect(rewritten).toContain('uid="uid://scene"');
    expect(rewritten).not.toContain('uid="uid://script"');
  });

  it('rejects invalid UTF-8 in text files', () => {
    expect(() => decodePackageText('x.gd', Buffer.from([0xff, 0xfe]))).toThrow(
      'package_text_not_utf8:x.gd',
    );
  });

  it('builds transitive same-package and cross-package scene dependencies', () => {
    const files = [
      {
        filepath: 'main.tscn',
        text:
          '[ext_resource type="Script" path="scripts/hero.gd" id="1"]\n' +
          '[ext_resource type="Texture2D" path="res://packages/6/tex.png" id="2"]',
      },
      {
        filepath: 'scripts/hero.gd',
        text: 'const Util = preload("res://packages/5/lib/util.gd")',
      },
      { filepath: 'lib/util.gd', text: 'extends Node' },
    ];
    const dependencies = new Map([
      [6, [{ filepath: 'tex.png', text: 'binary-placeholder' }]],
    ]);
    expect(
      buildSceneDependencies(5, files, dependencies, slugIndex, 5),
    ).toEqual({
      'main.tscn': [
        '5:main.tscn',
        '5:scripts/hero.gd',
        '5:lib/util.gd',
        '6:tex.png',
      ],
    });
  });

  it('builds scene dependencies through the slug index', () => {
    const index: PackageSlugIndex = {
      byId: new Map([[9, { slug: 'hero', roomId: null }]]),
      byRoomSlug: new Map(),
      byGlobalSlug: new Map([['hero', 9]]),
    };
    const rootFiles = [
      {
        filepath: 'scenes/main.tscn',
        text: '[ext_resource type="PackedScene" path="res://packages/hero/scenes/hero.tscn" id="1"]',
      },
    ];
    const dependencyFiles = new Map([
      [9, [{ filepath: 'scenes/hero.tscn', text: '[gd_scene format=3]' }]],
    ]);
    expect(
      buildSceneDependencies(7, rootFiles, dependencyFiles, index, 3),
    ).toEqual({
      'scenes/main.tscn': ['7:scenes/main.tscn', '9:scenes/hero.tscn'],
    });
  });
});
