import { render, screen } from '@testing-library/react';
import MarkdownRenderer from '@/components/docs/MarkdownRenderer';

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
});
