import {
  buildSceneDependencies,
  collectPackageReferences,
  decodePackageText,
  isTextPackageFile,
  rewritePackageReferences,
  stripExtResourceUids,
} from './package-runtime-references';

describe('package runtime references', () => {
  it('collects absolute package references', () => {
    expect(
      collectPackageReferences(
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
      collectPackageReferences(
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
    expect(collectPackageReferences(text)).toEqual([
      { packageId: 5, filepath: 'a.gd' },
    ]);
  });

  it('deduplicates repeated package references', () => {
    expect(
      collectPackageReferences(
        'preload("res://packages/5/a.gd") + preload("res://packages/5/a.gd")',
      ),
    ).toEqual([{ packageId: 5, filepath: 'a.gd' }]);
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

  it('rejects reference paths containing a "." or ".." segment', () => {
    expect(() =>
      collectPackageReferences('preload("res://packages/5/./hero.gd")'),
    ).toThrow('package_reference_invalid_path:./hero.gd');
    expect(() =>
      collectPackageReferences('preload("res://packages/5/a/../b.gd")'),
    ).toThrow('package_reference_invalid_path:a/../b.gd');
    expect(() =>
      collectPackageReferences('preload("res://packages/5/../6/x")'),
    ).toThrow('package_reference_invalid_path:../6/x');
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
