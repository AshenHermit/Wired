import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import MarkdownRenderer from '@/components/docs/MarkdownRenderer';
import { getDoc, listDocs } from '@/lib/content';
import { parseMarkdownHeadings } from '@/lib/markdown-parser';

describe('MarkdownRenderer', () => {
  test('renders markdown with code block syntax highlighting', () => {
    const md = `
## API Methods

Here's a TypeScript example:

\`\`\`typescript
function greet(name: string) {
  console.log('Hello, ' + name);
}
\`\`\`

More content here.
`;
    render(<MarkdownRenderer content={md} />);
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
    const codeBlock = screen.getByText(/greet/).closest('pre');
    expect(codeBlock).toHaveClass('hljs');
  });

  test('generates heading IDs for h2 and h3', () => {
    const md = `## Getting Started\n\n### Installation\n\n## API Reference`;
    render(<MarkdownRenderer content={md} />);
    
    const h2 = screen.getByRole('heading', { name: /Getting Started/ });
    expect(h2).toHaveAttribute('id', 'getting-started');
    
    const h3 = screen.getByRole('heading', { name: /Installation/ });
    expect(h3).toHaveAttribute('id', 'installation');
    
    const h2Second = screen.getByRole('heading', { name: /API Reference/ });
    expect(h2Second).toHaveAttribute('id', 'api-reference');
  });

  test('renders paragraph text', () => {
    const md = `## Section\n\nThis is a paragraph with some **bold** and *italic* text.`;
    render(<MarkdownRenderer content={md} />);
    expect(screen.getByText(/This is a paragraph/)).toBeInTheDocument();
  });

  test('renders unordered lists', () => {
    const md = `## List\n\n- Item 1\n- Item 2\n- Item 3`;
    render(<MarkdownRenderer content={md} />);
    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.getByText('Item 3')).toBeInTheDocument();
  });

  test('renders code blocks without language specified', () => {
    const md = `## Code\n\n\`\`\`\nplain code\n\`\`\``;
    render(<MarkdownRenderer content={md} />);
    expect(screen.getByText(/plain code/)).toBeInTheDocument();
  });

  test('derives heading ids from plain text, not React children', () => {
    render(
      <MarkdownRenderer content={'## `WiredPackageRegistration`\n\n## **Жирный** [ссылка](/x)'} />,
    );
    const ids = Array.from(document.querySelectorAll('h2')).map((h) => h.id);
    expect(ids).toEqual(['wiredpackageregistration', 'zhirnyy-ssylka']);
  });

  test('ignores headings inside fenced code blocks', () => {
    render(
      <MarkdownRenderer content={'## Real\n\n```md\n## Fake\n```\n\n### Also real'} />,
    );
    const ids = Array.from(document.querySelectorAll('h2, h3')).map(
      (h) => h.id,
    );
    expect(ids).toEqual(['real', 'also-real']);
  });

  test('heading ids stay stable when React re-invokes the render pass', () => {
    const md = '## См. также\n\n## См. также\n\n### Прочее';

    render(
      <StrictMode>
        <MarkdownRenderer content={md} />
      </StrictMode>,
    );

    const rendered = Array.from(document.querySelectorAll('h2, h3')).map(
      (heading) => heading.id,
    );
    expect(rendered).toEqual(parseMarkdownHeadings(md).map((h) => h.id));
  });

  test('every docs sidebar anchor resolves to a unique rendered heading id', async () => {
    const docs = await listDocs();
    expect(docs.length).toBeGreaterThan(0);

    for (const meta of docs) {
      const doc = await getDoc(meta.slug);
      expect(doc).not.toBeNull();

      const { container, unmount } = render(
        <MarkdownRenderer content={doc!.content} />,
      );
      const rendered = Array.from(container.querySelectorAll('h2, h3')).map(
        (heading) => heading.id,
      );
      const sidebar = parseMarkdownHeadings(doc!.content).map(
        (heading) => heading.id,
      );

      expect(rendered).toEqual(sidebar);
      expect(new Set(rendered).size).toBe(rendered.length);
      unmount();
    }
  });
});
