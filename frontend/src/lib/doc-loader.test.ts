import { loadDoc } from './doc-loader';

describe('loadDoc', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should load markdown file by name', async () => {
    const mockContent = '# Getting Started\n\nWelcome to Wired!';
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => mockContent,
    });

    const content = await loadDoc('getting-started');
    expect(content).toBe(mockContent);
    expect(global.fetch).toHaveBeenCalledWith('/docs/getting-started.md');
  });

  it('should throw error for non-existent doc', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    await expect(loadDoc('non-existent')).rejects.toThrow(
      'Failed to load documentation: non-existent'
    );
  });
});

