import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import DocsPage from '@/components/docs/DocsPage';

// Mock loadDoc to return test markdown
vi.mock('@/lib/doc-loader', () => ({
  loadDoc: vi.fn(async (docName: string) => {
    const docs: Record<string, string> = {
      'getting-started': `# Getting Started\n\n## Installation\n\nInstall the package.`,
    };
    return docs[docName] || '';
  }),
}));

describe('DocsPage', () => {
  test('renders layout with sidebar and main content', () => {
    render(<DocsPage initialDoc="getting-started" />);
    
    // Sidebar nav should exist
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    
    // Main area should exist
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  test('loads and renders markdown content', async () => {
    render(<DocsPage initialDoc="getting-started" />);
    
    // Wait for markdown to render
    await waitFor(() => {
      expect(screen.getByText('Install the package.')).toBeInTheDocument();
    });
  });
});
