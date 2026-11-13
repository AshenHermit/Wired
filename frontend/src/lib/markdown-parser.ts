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
 * Removes inline markdown markup so heading text and its anchor match what
 * ReactMarkdown renders (code, links, emphasis).
 */
export function plainHeadingText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .trim();
}

/**
 * Returns the first slug not present in `used`, appending a counter when a
 * previously generated id already occupies the slug.
 */
export function nextHeadingId(text: string, used: Set<string>): string {
  const base = slugify(text);
  let id = base;
  let counter = 1;

  while (used.has(id)) {
    id = slugify(text, counter);
    counter += 1;
  }

  return id;
}

/**
 * Parses markdown content and extracts h2/h3 headings with unique IDs
 * @param content - Raw markdown content
 * @returns Array of heading info with auto-generated unique IDs
 */
export function parseMarkdownHeadings(content: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const usedIds = new Set<string>();
  let fence: string | null = null;

  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = marker;
      } else if (fence === marker) {
        fence = null;
      }
      // Lines inside a fenced block are code, never headings.
      continue;
    }

    if (fence !== null) {
      continue;
    }

    // Match h2 (##) and h3 (###) headings, ignoring an optional closing ###.
    const match = /^(#{2,3})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (!match) {
      continue;
    }

    const level = match[1].length; // 2 for ##, 3 for ###
    const text = plainHeadingText(match[2]);
    const id = nextHeadingId(text, usedIds);
    usedIds.add(id);

    headings.push({ id, level, text });
  }

  return headings;
}
