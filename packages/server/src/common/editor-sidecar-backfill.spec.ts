import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { existsSync, readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { backfillEditorSidecars } from './editor-sidecar-backfill';

describe('backfillEditorSidecars', () => {
  it('does nothing when the script is not on disk', () => {
    expect(
      backfillEditorSidecars('nowhere', 'missing-editor-brotli.mjs'),
    ).toBeUndefined();
  });

  it('rebuilds missing sidecars through the script CLI', async () => {
    const editorPath = await mkdtemp(path.join(tmpdir(), 'wired-backfill-'));
    const raw = path.join(editorPath, 'godot.editor.wasm');
    await writeFile(raw, 'x'.repeat(4096));

    try {
      await backfillEditorSidecars(editorPath);

      const sidecar = `${raw}.br`;
      expect(existsSync(sidecar)).toBe(true);
      expect(brotliDecompressSync(readFileSync(sidecar)).toString()).toBe(
        'x'.repeat(4096),
      );
    } finally {
      await rm(editorPath, { recursive: true, force: true });
    }
  });
});
