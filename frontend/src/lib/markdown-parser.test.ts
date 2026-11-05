import { slugify, parseMarkdownHeadings } from '@/lib/markdown-parser';

describe('slugify', () => {
  test('converts heading text to URL-safe ID', () => {
    expect(slugify('Getting Started')).toBe('getting-started');
    expect(slugify('Godot API Reference')).toBe('godot-api-reference');
    expect(slugify('Entity Registration & Sync')).toBe('entity-registration-sync');
    expect(slugify('Multi-Player Guide')).toBe('multi-player-guide');
  });

  test('handles duplicates by appending counter', () => {
    expect(slugify('Setup', 0)).toBe('setup');
    expect(slugify('Setup', 1)).toBe('setup-1');
    expect(slugify('Setup', 2)).toBe('setup-2');
  });

  test('removes special characters and normalizes spaces', () => {
    expect(slugify('Hello   World')).toBe('hello-world');
    expect(slugify('test@#$%')).toBe('test');
    expect(slugify('CamelCase')).toBe('camelcase');
  });
});

describe('parseMarkdownHeadings', () => {
  test('extracts h2 and h3 headings with unique IDs', () => {
    const md = `
## Getting Started
Some content here

### Installation
More content

### Configuration
Even more content

## API Methods
API content
`;
    const headings = parseMarkdownHeadings(md);
    expect(headings).toHaveLength(4);
    expect(headings[0]).toEqual({ id: 'getting-started', level: 2, text: 'Getting Started' });
    expect(headings[1]).toEqual({ id: 'installation', level: 3, text: 'Installation' });
    expect(headings[2]).toEqual({ id: 'configuration', level: 3, text: 'Configuration' });
    expect(headings[3]).toEqual({ id: 'api-methods', level: 2, text: 'API Methods' });
  });

  test('handles duplicate heading texts by appending counter', () => {
    const md = `
## Setup
Content 1

## Setup
Content 2

## Setup
Content 3
`;
    const headings = parseMarkdownHeadings(md);
    expect(headings).toHaveLength(3);
    expect(headings[0].id).toBe('setup');
    expect(headings[1].id).toBe('setup-1');
    expect(headings[2].id).toBe('setup-2');
  });

  test('ignores h1 and h4+ headings', () => {
    const md = `
# Main Title
Content

## Section
Content

### Subsection
Content

#### Deep
Content
`;
    const headings = parseMarkdownHeadings(md);
    expect(headings).toHaveLength(2);
    expect(headings[0].level).toBe(2);
    expect(headings[1].level).toBe(3);
  });

  test('handles empty markdown', () => {
    expect(parseMarkdownHeadings('')).toEqual([]);
    expect(parseMarkdownHeadings('No headings here')).toEqual([]);
  });
});
