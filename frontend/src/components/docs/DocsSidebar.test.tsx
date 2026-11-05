import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DocsSidebar from '@/components/docs/DocsSidebar';

// Mock loadDoc to return test markdown
jest.mock('@/lib/doc-loader', () => ({
  loadDoc: jest.fn(async (docName: string) => {
    const docs: Record<string, string> = {
      'getting-started': `## Getting Started\n\n### Installation\n\n### Configuration`,
      'api-reference': `## API Reference\n\n### Methods\n\n### Classes`,
      'entity-registration': `## Entity Registration`,
      'multiplayer-guide': `## Multiplayer Guide\n\n### Networking`,
    };
    return docs[docName] || '';
  }),
}));

describe('DocsSidebar', () => {
  test('renders sidebar with 4 main doc links', async () => {
    render(<DocsSidebar currentDoc="getting-started" onDocChange={() => {}} />);
    
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
    expect(screen.getByText('Entity Registration')).toBeInTheDocument();
    expect(screen.getByText('Multiplayer Guide')).toBeInTheDocument();
  });

  test('highlights current document', () => {
    render(<DocsSidebar currentDoc="api-reference" onDocChange={() => {}} />);
    const apiLink = screen.getByText('API Reference').closest('a');
    expect(apiLink).toHaveClass('bg-foreground/10');
  });

  test('expands current doc to show anchors', async () => {
    render(<DocsSidebar currentDoc="getting-started" onDocChange={() => {}} />);
    
    // Wait for content to load and anchors to be visible
    await screen.findByText('Installation');
    expect(screen.getByText('Installation')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  test('non-current docs do not show anchors', async () => {
    render(<DocsSidebar currentDoc="getting-started" onDocChange={() => {}} />);
    
    // Getting Started should show anchors
    await screen.findByText('Installation');
    
    // API Reference anchors should NOT be visible
    expect(screen.queryByText('Methods')).not.toBeInTheDocument();
  });

  test('anchor links have correct href attribute', async () => {
    render(<DocsSidebar currentDoc="getting-started" onDocChange={() => {}} />);
    
    const installLink = await screen.findByText('Installation');
    expect(installLink).toHaveAttribute('href', '#installation');
  });
});
