const TRANSLITERATION: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * Converts text to URL-safe slug ID
 * @param text - The heading text to convert
 * @param counter - Optional counter to append for duplicates (e.g., "heading-1")
 * @returns URL-safe slug string
 */
export function slugify(text: string, counter?: number): string {
  const transliterated = Array.from(text.toLowerCase())
    .map((char) => TRANSLITERATION[char] ?? char)
    .join('');

  let slug = transliterated
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens

  if (!slug) {
    slug = 'section';
  }

  if (typeof counter === 'number' && counter > 0) {
    slug = `${slug}-${counter}`;
  }

  return slug;
}

export interface HeadingInfo {
  id: string;
  level: number;
  text: string;
}

/**
 * Parses markdown content and extracts h2/h3 headings with unique IDs
 * @param content - Raw markdown content
 * @returns Array of heading info with auto-generated unique IDs
 */
export function parseMarkdownHeadings(content: string): HeadingInfo[] {
  // Match h2 (##) and h3 (###) headings
  const headingRegex = /^(#{2,3})\s+(.+?)$/gm;
  const headings: HeadingInfo[] = [];
  const seenIds = new Map<string, number>(); // Track ID occurrences for duplicates

  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length; // 2 for ##, 3 for ###
    const text = match[2].trim();
    let id = slugify(text);

    // Handle duplicate IDs by appending counter
    if (seenIds.has(id)) {
      const count = seenIds.get(id)!;
      seenIds.set(id, count + 1);
      id = slugify(text, count);
    } else {
      seenIds.set(id, 1);
    }

    headings.push({ id, level, text });
  }

  return headings;
}
