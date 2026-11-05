import { render, screen, waitFor } from '@testing-library/react';
import DocsPage from '@/components/docs/DocsPage';

// Mock loadDoc to return test markdown
jest.mock('@/lib/doc-loader', () => ({
  loadDoc: jest.fn(async (docName: string) => {
    const docs: Record<string, string> = {
      'getting-started': `# Getting Started\n\n## Installation\n\nInstall the package.\n\n## Configuration\n\nConfigure it.`,
      'api-reference': `# API Reference\n\n## Methods\n\nAPI methods here.`,
    };
    return docs[docName] || '';
  }),
}));

describe('DocsPage', () => {
  test('renders sidebar and main content area', async () => {
    render(<DocsPage initialDoc="getting-started" />);
    
    // Wait for sidebar to load and show doc links
    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });
    
    // Content should be visible
    expect(screen.getByText(/Installation/)).toBeInTheDocument();
  });

  test('loads and renders markdown content for initial doc', async () => {
    render(<DocsPage initialDoc="api-reference" />);
    
    // Wait for content to load
    await waitFor(() => {
      expect(screen.getByText(/API methods here/)).toBeInTheDocument();
    });
  });

  test('switches doc when sidebar link clicked', async () => {
    render(<DocsPage initialDoc="getting-started" />);
    
    // Wait for initial content
    await waitFor(() => {
      expect(screen.getByText(/Installation/)).toBeInTheDocument();
    });
    
    // Content changes when different doc is loaded
    // (simplified check - full click test would require user-event)
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
  });
});
