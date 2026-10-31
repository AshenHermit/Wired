import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  BACKUP_DIR_PREFIX,
  installEditorSet,
  isEditorInstalled,
} from './editor-install.mjs';

const VERSION = '4.7.2-stable';

function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'wired-editor-install-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeSet(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(join(dir, entry.name), name));
    } else if (entry.isFile()) {
      files.push(name);
    }
  }
  return files.sort();
}

function readSet(dir) {
  const files = {};
  for (const name of listFiles(dir)) {
    files[name] = readFileSync(join(dir, name), 'utf8');
  }
  return files;
}

function backupDirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_DIR_PREFIX))
    .map((entry) => entry.name);
}

test('fresh install writes every file and VERSION', () => {
  withTempRoot((root) => {
    const source = join(root, 'source');
    const dest = join(root, 'dest');
    const files = {
      'godot.editor.js': 'new js',
      'godot.editor.wasm': 'new wasm',
      'godot.editor.html': 'new html',
      'manifest.json': 'new manifest',
      'fonts/inter.woff2': 'new font',
    };
    writeSet(source, files);

    const result = installEditorSet({ destDir: dest, sourceDir: source, version: VERSION });

    assert.deepEqual(result, { files: Object.keys(files).sort(), version: VERSION });
    assert.deepEqual(readSet(dest), { ...files, VERSION: `${VERSION}\n` });
    assert.deepEqual(backupDirs(dest), []);
  });
});

test('restores the complete old set byte-for-byte when a move fails', () => {
  withTempRoot((root) => {
    const source = join(root, 'source');
    const dest = join(root, 'dest');
    const newSet = {
      'godot.editor.js': 'new js',
      'godot.editor.wasm': 'new wasm',
      'godot.editor.html': 'new html',
      'manifest.json': 'new manifest',
      'offline.html': 'new offline',
      'service.worker.js': 'new worker',
      'favicon.png': 'new favicon',
      'inter-bold.woff2': 'new font',
    };
    const oldSet = {
      'godot.editor.js': 'old js',
      'godot.editor.wasm': 'old wasm',
      'godot.editor.html': 'old html',
      'manifest.json': 'old manifest',
      'offline.html': 'old offline',
      'service.worker.js': 'old worker',
      'favicon.png': 'old favicon',
      'inter-bold.woff2': 'old font',
      'godot.editor.legacy.js': 'stale legacy',
      VERSION: `${VERSION}\n`,
    };
    writeSet(source, newSet);
    writeSet(dest, oldSet);

    assert.throws(
      () =>
        installEditorSet({
          destDir: dest,
          sourceDir: source,
          version: VERSION,
          hooks: {
            beforeMove(name) {
              if (name === 'manifest.json') {
                throw new Error('injected move failure');
              }
            },
          },
        }),
      /injected move failure/,
    );

    // Every old file, including non-core files and VERSION, is back exactly;
    // nothing from the partial install survives.
    assert.deepEqual(readSet(dest), oldSet);
    assert.deepEqual(backupDirs(dest), []);
  });
});

test('moves VERSION aside before any new file so a kill cannot look installed', () => {
  withTempRoot((root) => {
    const source = join(root, 'source');
    const dest = join(root, 'dest');
    writeSet(source, {
      'godot.editor.js': 'new js',
      'godot.editor.wasm': 'new wasm',
      'godot.editor.html': 'new html',
      'manifest.json': 'new manifest',
    });
    writeSet(dest, {
      'godot.editor.js': 'old js',
      'godot.editor.wasm': 'old wasm',
      'godot.editor.html': 'old html',
      'manifest.json': 'old manifest',
      VERSION: `${VERSION}\n`,
    });
    assert.equal(isEditorInstalled({ destDir: dest, version: VERSION }), true);

    let versionPresent = true;
    let lookedInstalled = true;
    assert.throws(
      () =>
        installEditorSet({
          destDir: dest,
          sourceDir: source,
          version: VERSION,
          hooks: {
            beforeMove() {
              versionPresent = existsSync(join(dest, 'VERSION'));
              lookedInstalled = isEditorInstalled({ destDir: dest, version: VERSION });
              throw new Error('simulated kill');
            },
          },
        }),
      /simulated kill/,
    );

    // This is the kill-like window: no new file has been moved yet, and the
    // old VERSION is already out of the way.
    assert.equal(versionPresent, false);
    assert.equal(lookedInstalled, false);
  });
});

test('failure during backup restores only moved files and keeps the rest', () => {
  withTempRoot((root) => {
    const source = join(root, 'source');
    const dest = join(root, 'dest');
    writeSet(source, {
      'godot.editor.js': 'new js',
      'godot.editor.wasm': 'new wasm',
      'godot.editor.html': 'new html',
      'manifest.json': 'new manifest',
    });
    const oldSet = {
      'godot.editor.js': 'old js',
      'godot.editor.wasm': 'old wasm',
      'godot.editor.html': 'old html',
      'manifest.json': 'old manifest',
      VERSION: '4.6.0-stable\n',
    };
    writeSet(dest, oldSet);

    assert.throws(
      () =>
        installEditorSet({
          destDir: dest,
          sourceDir: source,
          version: VERSION,
          hooks: {
            beforeBackup(name) {
              // VERSION and godot.editor.html are already in the backup at
              // this point; .js/.wasm never left the destination.
              if (name === 'godot.editor.js') {
                throw new Error('injected backup failure');
              }
            },
          },
        }),
      /injected backup failure/,
    );

    assert.deepEqual(readSet(dest), oldSet);
    assert.deepEqual(backupDirs(dest), []);
  });
});

test('removes leftover backup directories after a successful install', () => {
  withTempRoot((root) => {
    const source = join(root, 'source');
    const dest = join(root, 'dest');
    writeSet(source, {
      'godot.editor.js': 'new js',
      'godot.editor.wasm': 'new wasm',
      'godot.editor.html': 'new html',
    });
    writeSet(dest, { 'godot.editor.js': 'old js' });
    const staleBackup = join(dest, `${BACKUP_DIR_PREFIX}stale`);
    writeSet(staleBackup, { 'leftover.bin': 'leftover' });

    installEditorSet({ destDir: dest, sourceDir: source, version: VERSION });

    assert.equal(existsSync(staleBackup), false);
    assert.deepEqual(backupDirs(dest), []);
    assert.equal(readFileSync(join(dest, 'VERSION'), 'utf8'), `${VERSION}\n`);
  });
});
