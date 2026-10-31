import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  TEMPLATES_ASSET,
  TEMPLATES_DIRECTORY,
  exportTemplatesDirectory,
  hasWebTemplates,
  installWebTemplates,
  verifyTemplatesArchive,
} from './export-templates.mjs';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wired-templates-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('resolves the Windows template directory from APPDATA', () => {
  assert.equal(
    exportTemplatesDirectory({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      home: 'C:\\Users\\test',
    }),
    join(
      'C:\\Users\\test\\AppData\\Roaming',
      'Godot',
      'export_templates',
      TEMPLATES_DIRECTORY,
    ),
  );
});

test('falls back to home when APPDATA is missing', () => {
  assert.equal(
    exportTemplatesDirectory({
      platform: 'win32',
      env: {},
      home: 'C:\\Users\\test',
    }),
    join('C:\\Users\\test', 'AppData', 'Roaming', 'Godot', 'export_templates', TEMPLATES_DIRECTORY),
  );
});

test('resolves the macOS template directory', () => {
  assert.equal(
    exportTemplatesDirectory({
      platform: 'darwin',
      env: {},
      home: '/Users/test',
    }),
    join(
      '/Users/test',
      'Library',
      'Application Support',
      'Godot',
      'export_templates',
      TEMPLATES_DIRECTORY,
    ),
  );
});

test('resolves the Linux template directory from XDG_DATA_HOME', () => {
  assert.equal(
    exportTemplatesDirectory({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/tmp/xdg' },
      home: '/home/test',
    }),
    join('/tmp/xdg', 'godot', 'export_templates', TEMPLATES_DIRECTORY),
  );
});

test('falls back to the Linux home data directory', () => {
  assert.equal(
    exportTemplatesDirectory({
      platform: 'linux',
      env: {},
      home: '/home/test',
    }),
    join('/home/test', '.local', 'share', 'godot', 'export_templates', TEMPLATES_DIRECTORY),
  );
});

test('rejects unsupported platforms', () => {
  assert.throws(
    () =>
      exportTemplatesDirectory({
        platform: 'freebsd',
        env: {},
        home: '/home/test',
      }),
    /freebsd/,
  );
});

test('detects both required web templates', () =>
  withTempDir((dir) => {
    assert.equal(hasWebTemplates(dir), false);
    writeFileSync(join(dir, 'web_debug.zip'), 'debug');
    assert.equal(hasWebTemplates(dir), false);
    writeFileSync(join(dir, 'web_release.zip'), 'release');
    assert.equal(hasWebTemplates(dir), true);
    rmSync(join(dir, 'web_release.zip'));
    mkdirSync(join(dir, 'web_release.zip'));
    assert.equal(hasWebTemplates(dir), false);
  }));

test('verifies archive size and sha256', () => {
  const buffer = Buffer.from('templates');
  const digest = sha256(buffer);
  const asset = { name: 'templates.tpz', size: buffer.length, sha256: digest };

  assert.doesNotThrow(() => verifyTemplatesArchive(buffer, asset));
  assert.throws(
    () => verifyTemplatesArchive(Buffer.concat([buffer, Buffer.from('!')]), asset),
    /размер/i,
  );
  assert.throws(
    () => verifyTemplatesArchive(buffer, { ...asset, sha256: '0'.repeat(64) }),
    /sha256/i,
  );
});

test('installs web templates without removing other templates', () =>
  withTempDir((dir) => {
    const extracted = join(dir, 'extracted');
    const templates = join(dir, 'templates');
    mkdirSync(join(extracted, 'templates'), { recursive: true });
    mkdirSync(templates, { recursive: true });
    writeFileSync(join(extracted, 'templates', 'web_debug.zip'), 'debug');
    writeFileSync(join(extracted, 'templates', 'web_release.zip'), 'release');
    writeFileSync(join(templates, 'other.zip'), 'other');
    writeFileSync(join(templates, 'web_debug.zip'), 'old');

    installWebTemplates({ extractedDir: extracted, templatesDir: templates });

    assert.equal(readFileSync(join(templates, 'web_debug.zip'), 'utf8'), 'debug');
    assert.equal(readFileSync(join(templates, 'web_release.zip'), 'utf8'), 'release');
    assert.equal(readFileSync(join(templates, 'other.zip'), 'utf8'), 'other');
    assert.equal(hasWebTemplates(templates), true);
  }));

test('leaves existing templates intact when a source file is missing', () =>
  withTempDir((dir) => {
    const extracted = join(dir, 'extracted');
    const templates = join(dir, 'templates');
    mkdirSync(join(extracted, 'templates'), { recursive: true });
    mkdirSync(templates, { recursive: true });
    writeFileSync(join(extracted, 'templates', 'web_debug.zip'), 'debug');
    writeFileSync(join(templates, 'web_debug.zip'), 'old');

    assert.throws(
      () => installWebTemplates({ extractedDir: extracted, templatesDir: templates }),
      /web_release/,
    );
    assert.equal(readFileSync(join(templates, 'web_debug.zip'), 'utf8'), 'old');
    assert.equal(existsSync(join(templates, 'web_release.zip')), false);
  }));

test('pins the official 4.7.2 archive metadata', () => {
  assert.equal(TEMPLATES_ASSET.name, 'Godot_v4.7.2-stable_export_templates.tpz');
  assert.equal(TEMPLATES_ASSET.size, 1_281_349_702);
  assert.equal(
    TEMPLATES_ASSET.sha256,
    'f298490b8d44d934be425a5a65a51bf15f422428b229a06a6e11d9ffea248011',
  );
  assert.equal(TEMPLATES_DIRECTORY, '4.7.2.stable');
});
