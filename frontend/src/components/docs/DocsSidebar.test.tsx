import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import DocsSidebar from '@/components/docs/DocsSidebar';

// Mock loadDoc to return test markdown
vi.mock('@/lib/doc-loader', () => ({
  loadDoc: vi.fn(async (docName: string) => {
    const docs: Record<string, string> = {
      'getting-started': `## Getting Started\n\n### Installation\n\n### Configuration`,
      'api-reference': `## API Reference\n\n### Methods`,
    };
    return docs[docName] || '';
  }),
}));

describe('DocsSidebar', () => {
  test('renders as navigation element', () => {
    render(<DocsSidebar currentDoc="getting-started" onDocChange={() => {}} />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  test('expands current doc to show anchors', async () => {
    render(<DocsSidebar currentDoc="getting-started" onDocChange={() => {}} />);
    
    // Wait for anchors to load
    await waitFor(() => {
      expect(screen.getByText('Installation')).toBeInTheDocument();
    });
  });

  test('non-current docs do not show anchors', async () => {
    render(<DocsSidebar currentDoc="getting-started" onDocChange={() => {}} />);
    
    // Getting Started anchors should load
    await waitFor(() => {
      expect(screen.getByText('Installation')).toBeInTheDocument();
    });
    
    // API Reference anchors should NOT be visible
    expect(screen.queryByText('Methods')).not.toBeInTheDocument();
  });
});
