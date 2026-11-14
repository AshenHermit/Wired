import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_PATH = 'scripts/lib/editor-brotli.mjs';

/**
 * Rebuilds missing/stale `.br` sidecars for the installed editor by running
 * the same CLI `fetch:editor` uses. Runs as a child process because
 * `brotliCompressSync` on the wasm blob blocks for seconds — never on the
 * Nest event loop. Skips silently when the script is not on disk (production
 * images bake sidecars at build time and don't ship `scripts/`). Until the
 * backfill finishes, the editor is served raw; a failed backfill keeps it
 * raw forever.
 */
export function backfillEditorSidecars(
  editorPath: string,
  scriptPath: string = resolve(SCRIPT_PATH),
): Promise<void> | undefined {
  if (!existsSync(editorPath) || !existsSync(scriptPath)) {
    return undefined;
  }
  return new Promise((settle) => {
    const child = spawn(process.execPath, [scriptPath, editorPath], {
      stdio: 'ignore',
    });
    child.on('error', () => settle());
    child.on('close', (code) => {
      if (code !== 0) {
        console.warn(
          `[editor-sidecars] backfill exited with ${code}; the editor stays raw`,
        );
      }
      settle();
    });
  });
}
