import {
  buildSceneDependencies,
  collectRawPackageReferences,
  decodePackageText,
  isTextPackageFile,
  resolvePackageReferences,
  rewritePackageReferences,
  stripExtResourceUids,
} from './package-runtime-references';

const slugIndex = {
  bySlug: new Map([['hero', 9]]),
  byId: new Map([[9, 'hero']]),
};

/** Collects and resolves references the way every production caller does. */
const collect = (text: string) =>
  resolvePackageReferences(collectRawPackageReferences(text), slugIndex)
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
      ),
    ).toEqual({
      resolved: [
        { packageId: 9, filepath: 'scene.tscn' },
        { packageId: 42, filepath: 'legacy.tscn' },
      ],
      unknown: [],
    });
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
        },
      ),
    ).toBe(
      'preload("user://wired/rooms/7/packages/5/3-k5/lib/a.gd") + ' +
        '"user://wired/rooms/7/packages/6/9-k6/tex.png"',
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
      }),
    ).toBe(
      '# preload("res://packages/99/foo.gd")\n' +
        'const A = preload("user://wired/rooms/7/packages/5/3-k5/a.gd")',
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
        },
      ),
    ).toBe(
      '; path="res://packages/99/missing.gd"\n' +
        'preload("user://wired/rooms/7/packages/5/3-k5/a.gd")',
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
      }),
    ).toThrow('package_reference_not_rewritable:99');
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
    expect(() =>
      rewritePackageReferences('preload("res://packages/5/./hero.gd")', {
        roomId: 7,
        revisionByPackage: revisions,
        artifactKeyByPackage: keys,
      }),
    ).toThrow('package_reference_invalid_path:./hero.gd');
    expect(() =>
      rewritePackageReferences('preload("res://packages/5/a/../b.gd")', {
        roomId: 7,
        revisionByPackage: revisions,
        artifactKeyByPackage: keys,
      }),
    ).toThrow('package_reference_invalid_path:a/../b.gd');
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
    expect(buildSceneDependencies(5, files, dependencies)).toEqual({
      'main.tscn': [
        '5:main.tscn',
        '5:scripts/hero.gd',
        '5:lib/util.gd',
        '6:tex.png',
      ],
    });
  });
});
