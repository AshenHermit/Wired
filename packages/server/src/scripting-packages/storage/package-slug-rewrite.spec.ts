import { rewriteSlugReferences } from './package-slug-rewrite';

describe('rewriteSlugReferences', () => {
  it('rewrites a whole-slug reference in a scene', () => {
    const input = Buffer.from(
      '[node]\npath = "res://packages/hero/scenes/body.tscn"\n',
    );

    expect(
      rewriteSlugReferences(
        'scenes/level.tscn',
        input,
        'hero',
        'hero2',
      ).toString(),
    ).toContain('res://packages/hero2/scenes/body.tscn');
  });

  it('does not touch a longer slug that starts the same way', () => {
    const input = Buffer.from('res://packages/hero_2/body.tscn');

    expect(rewriteSlugReferences('a.gd', input, 'hero', 'hero2')).toEqual(
      input,
    );
  });

  it('leaves binary files unchanged', () => {
    const input = Buffer.from('res://packages/hero/x.png', 'utf8');

    expect(rewriteSlugReferences('assets/x.png', input, 'hero', 'hero2')).toBe(
      input,
    );
  });

  it('rewrites .import sidecars', () => {
    const input = Buffer.from('source_file="res://packages/hero/a.png"');

    expect(
      rewriteSlugReferences('a.png.import', input, 'hero', 'h2').toString(),
    ).toBe('source_file="res://packages/h2/a.png"');
  });
});
