import { BadRequestException } from '@nestjs/common';

/** Workshop tags are lowercase tokens so filtering is case-insensitive. */
const TAG_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const MAX_PACKAGE_TAGS = 10;

/**
 * Trims, lowercases and de-duplicates workshop tags. An invalid tag is a
 * client error and is echoed back so the UI can point at the input.
 */
export function normalizeTags(input: string[]): string[] {
  const result: string[] = [];
  for (const raw of input ?? []) {
    const tag = String(raw).trim().toLowerCase();
    if (!TAG_PATTERN.test(tag)) {
      throw new BadRequestException({ code: 'invalid_tags', tag: raw });
    }
    if (!result.includes(tag)) result.push(tag);
  }
  if (result.length > MAX_PACKAGE_TAGS) {
    throw new BadRequestException({
      code: 'invalid_tags',
      tag: result[MAX_PACKAGE_TAGS],
    });
  }
  return result;
}
