/**
 * Converts text to URL-safe slug ID
 * @param text - The heading text to convert
 * @param counter - Optional counter to append for duplicates (e.g., "heading-1")
 * @returns URL-safe slug string
 */
export function slugify(text: string, counter?: number): string {
  let slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens

  if (typeof counter === 'number' && counter > 0) {
    slug = `${slug}-${counter}`;
  }

  return slug;
}

interface HeadingInfo {
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
