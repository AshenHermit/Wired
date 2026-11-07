import { execFileSync } from 'child_process';
import * as path from 'path';
import { IsWiredMediaUrlConstraint } from './is-wired-media-url.decorator';

/**
 * Nest `start:dev` resolves `@wired-io/shared` via package.json `main` (dist/),
 * not tsconfig paths. Jest maps to src — so this test loads dist via a child
 * Node process (same resolver Nest uses at runtime).
 * Break this catches: stale/missing shared dist export of isWiredMediaUrl → 500
 * on package/room save with previewImage.
 */
describe('@wired-io/shared package main (Nest runtime)', () => {
  it('exports isWiredMediaUrl from dist', () => {
    const distIndex = path.resolve(
      __dirname,
      '../../../shared/dist/index.js',
    );
    const script = [
      `const m = require(${JSON.stringify(distIndex)});`,
      `if (typeof m.isWiredMediaUrl !== 'function') {`,
      `  console.error('isWiredMediaUrl type=' + typeof m.isWiredMediaUrl);`,
      `  process.exit(1);`,
      `}`,
      `const ok = m.isWiredMediaUrl('/media/' + 'a'.repeat(64) + '.png');`,
      `const bad = m.isWiredMediaUrl('/media/not-a-hash.png');`,
      `if (!ok || bad) process.exit(2);`,
    ].join('');

    expect(() =>
      execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }),
    ).not.toThrow();
  });
});

describe('IsWiredMediaUrlConstraint', () => {
  const constraint = new IsWiredMediaUrlConstraint();

  it('accepts a Wired media URL', () => {
    expect(constraint.validate(`/media/${'b'.repeat(64)}.jpg`)).toBe(true);
  });

  it('rejects a non-media URL string', () => {
    expect(constraint.validate('https://example.com/x.png')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(constraint.validate(null)).toBe(false);
    expect(constraint.validate(undefined)).toBe(false);
  });
});
