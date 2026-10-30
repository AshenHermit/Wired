import {
  buildSceneDependencies,
  collectPackageReferences,
  decodePackageText,
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

  it('rewrites every package prefix to the pinned runtime revision', () => {
    const revisions = new Map([
      [5, 3],
      [6, 9],
    ]);
    expect(
      rewritePackageReferences(
        'preload("res://packages/5/lib/a.gd") + "res://packages/6/tex.png"',
        { roomId: 7, revisionByPackage: revisions },
      ),
    ).toBe(
      'preload("user://wired/rooms/7/packages/5/3/lib/a.gd") + ' +
        '"user://wired/rooms/7/packages/6/9/tex.png"',
    );
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
