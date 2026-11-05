import { render, screen, waitFor } from '@testing-library/react';
import { DocViewer } from './DocViewer';
import { vi } from 'vitest';

vi.mock('@/lib/doc-loader', () => ({
  loadDoc: vi
    .fn()
    .mockResolvedValue('# Test\n\nContent here'),
}));

describe('DocViewer', () => {
  it('should render markdown content', async () => {
    render(<DocViewer docName="getting-started" />);
    await waitFor(() => {
      expect(screen.getByText(/content here/i)).toBeDefined();
    });
  });

  it('should display error on load failure', async () => {
    const { loadDoc } = await import('@/lib/doc-loader');
    vi.mocked(loadDoc).mockRejectedValueOnce(new Error('Not found'));
    render(<DocViewer docName="invalid" />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeDefined();
    });
  });
});

