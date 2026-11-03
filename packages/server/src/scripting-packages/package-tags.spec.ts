import { BadRequestException } from '@nestjs/common';
import { MAX_PACKAGE_TAGS, normalizeTags } from './package-tags';

describe('normalizeTags', () => {
  it('trims, lowercases and de-duplicates tags', () => {
    expect(normalizeTags([' Hero ', 'hero', '2D', 'a_b-c'])).toEqual([
      'hero',
      '2d',
      'a_b-c',
    ]);
  });

  it('rejects a tag outside the allowed alphabet', () => {
    const error = catchError(() => normalizeTags(['плохой']));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      code: 'invalid_tags',
      tag: 'плохой',
    });
  });

  it('rejects a tag longer than 32 characters', () => {
    expect(() => normalizeTags(['a'.repeat(33)])).toThrow(BadRequestException);
  });

  it('rejects more tags than the limit', () => {
    const tags = Array.from(
      { length: MAX_PACKAGE_TAGS + 1 },
      (_, i) => `t${i}`,
    );

    const error = catchError(() => normalizeTags(tags));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      code: 'invalid_tags',
      tag: `t${MAX_PACKAGE_TAGS}`,
    });
  });

  it('keeps the limit after duplicates are collapsed', () => {
    const tags = [
      ...Array.from({ length: MAX_PACKAGE_TAGS }, (_, i) => `T${i}`),
      't0',
    ];

    expect(normalizeTags(tags)).toHaveLength(MAX_PACKAGE_TAGS);
  });

  it('accepts an empty tag list', () => {
    expect(normalizeTags([])).toEqual([]);
  });
});

function catchError(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
