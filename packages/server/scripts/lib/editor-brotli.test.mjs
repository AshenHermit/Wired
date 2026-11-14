import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';

import { compressEditorSidecars } from './editor-brotli.mjs';

const BIG = 'x'.repeat(64 * 1024);

function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'wired-editor-brotli-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeSet(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

test('creates sidecars above the size threshold, including subdirectories', () => {
  withTempRoot((root) => {
    writeSet(root, {
      'godot.editor.wasm': BIG,
      'assets/font.woff2': BIG,
      'tiny.txt': 'hi',
    });

    const { written } = compressEditorSidecars({ dir: root });

    assert.deepEqual(written, ['assets/font.woff2', 'godot.editor.wasm']);
    assert.deepEqual(
      brotliDecompressSync(readFileSync(join(root, 'godot.editor.wasm.br'))),
      Buffer.from(BIG),
    );
    assert.deepEqual(
      brotliDecompressSync(readFileSync(join(root, 'assets', 'font.woff2.br'))),
      Buffer.from(BIG),
    );
    assert.equal(existsSync(join(root, 'tiny.txt.br')), false);
  });
});

test('applies the size threshold', () => {
  withTempRoot((root) => {
    writeSet(root, { 'small.js': 'x'.repeat(20) });

    assert.deepEqual(compressEditorSidecars({ dir: root }).written, []);
    assert.equal(existsSync(join(root, 'small.js.br')), false);

    const { written } = compressEditorSidecars({ dir: root, minBytes: 1 });
    assert.deepEqual(written, ['small.js']);
    assert.equal(existsSync(join(root, 'small.js.br')), true);
  });
});

test('drops an oversized sidecar for incompressible content', () => {
  withTempRoot((root) => {
    writeSet(root, {
      'noise.bin': randomBytes(8192),
      'noise.bin.br': randomBytes(9999),
    });
    // Backdate the junk sidecar so it is stale (sidecar mtime < raw mtime).
    const sidecar = join(root, 'noise.bin.br');
    const past = statSync(sidecar).mtimeMs - 5000;
    // Node treats numeric utimes as seconds — pass Date objects (ms).
    utimesSync(sidecar, new Date(past), new Date(past));

    const { written } = compressEditorSidecars({ dir: root });

    assert.deepEqual(written, []);
    assert.equal(existsSync(join(root, 'noise.bin.br')), false);
  });
});

test('recompresses a stale sidecar', () => {
  withTempRoot((root) => {
    writeSet(root, {
      'godot.editor.js': BIG,
      'godot.editor.js.br': 'junk',
    });
    // Backdate the junk sidecar so it is stale (sidecar mtime < raw mtime).
    const sidecar = join(root, 'godot.editor.js.br');
    const past = statSync(sidecar).mtimeMs - 5000;
    // Node treats numeric utimes as seconds — pass Date objects (ms).
    utimesSync(sidecar, new Date(past), new Date(past));

    const { written } = compressEditorSidecars({ dir: root });

    assert.deepEqual(written, ['godot.editor.js']);
    assert.deepEqual(
      brotliDecompressSync(readFileSync(join(root, 'godot.editor.js.br'))),
      Buffer.from(BIG),
    );
  });
});

test('backfill is idempotent', () => {
  withTempRoot((root) => {
    writeSet(root, { 'godot.editor.wasm': BIG });
    assert.deepEqual(compressEditorSidecars({ dir: root }).written, [
      'godot.editor.wasm',
    ]);

    assert.deepEqual(compressEditorSidecars({ dir: root }).written, []);
  });
});

test('CLI writes sidecars and exits 0', () => {
  withTempRoot((root) => {
    writeSet(root, { 'godot.editor.wasm': BIG });

    const result = spawnSync(
      process.execPath,
      [resolve('scripts/lib/editor-brotli.mjs'), root],
      { cwd: resolve(import.meta.dirname, '..', '..'), encoding: 'utf8' },
    );

    assert.equal(
      result.status,
      0,
      `CLI failed: ${result.stderr ?? result.error}`,
    );
    assert.equal(existsSync(join(root, 'godot.editor.wasm.br')), true);
  });
});
