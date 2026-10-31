import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  downloadRuntimeArchive,
  installRuntime,
  isRuntimeInstalled,
  readRuntimeManifest,
  resolveRuntimeExecutable,
  selectRuntimeAsset,
  verifyRuntimeArchive,
} from './runtime-install.mjs';

const VERSION = '4.7.2-stable';
const created = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'wired-runtime-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true });
  }
});

test('selects an official asset for every supported platform', () => {
  assert.equal(
    selectRuntimeAsset('win32', 'x64').name,
    'Godot_v4.7.2-stable_win64.exe.zip',
  );
  assert.equal(
    selectRuntimeAsset('linux', 'arm64').name,
    'Godot_v4.7.2-stable_linux.arm64.zip',
  );
  assert.equal(
    selectRuntimeAsset('darwin', 'arm64').name,
    'Godot_v4.7.2-stable_macos.universal.zip',
  );
  assert.equal(
    selectRuntimeAsset('darwin', 'x64').name,
    'Godot_v4.7.2-stable_macos.universal.zip',
  );
});

test('rejects platforms without an official native build', () => {
  assert.throws(
    () => selectRuntimeAsset('freebsd', 'x64'),
    /freebsd/,
  );
  assert.throws(
    () => selectRuntimeAsset('win32', 'mips'),
    /mips/,
  );
});

test('verifies the archive size and sha256 before install', () => {
  const asset = {
    size: 3,
    sha256: createHash('sha256').update('abc').digest('hex'),
  };
  assert.equal(verifyRuntimeArchive(Buffer.from('abc'), asset), undefined);
  assert.throws(
    () => verifyRuntimeArchive(Buffer.from('ab'), asset),
    /размер/,
  );
  assert.throws(
    () => verifyRuntimeArchive(Buffer.from('abd'), asset),
    /sha256/,
  );
});

test('downloads and verifies an official archive', async () => {
  const asset = {
    name: 'Godot_v4.7.2-stable_win64.exe.zip',
    size: 3,
    sha256: createHash('sha256').update('abc').digest('hex'),
  };
  let requested = '';
  const buffer = await downloadRuntimeArchive(asset, async (url) => {
    requested = url;
    return {
      ok: true,
      arrayBuffer: async () => Buffer.from('abc'),
    };
  });

  assert.equal(buffer.toString(), 'abc');
  assert.match(requested, /godot-builds\/releases\/download\/4\.7\.2-stable\//);
  assert.match(requested, /Godot_v4\.7\.2-stable_win64\.exe\.zip$/);
});

test('reports an HTTP failure before touching the install', async () => {
  const asset = {
    name: 'Godot_v4.7.2-stable_win64.exe.zip',
    size: 3,
    sha256: '',
  };

  await assert.rejects(
    () =>
      downloadRuntimeArchive(asset, async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })),
    /HTTP 404/,
  );
});

test('installs a runtime and writes a manifest last', () => {
  const root = tempDir();
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'Godot_v4.7.2-stable_win64.exe'), 'binary');
  writeFileSync(join(source, 'Godot_v4.7.2-stable_win64_console.exe'), 'console');
  const runtimeDir = join(root, 'godot_runtime');

  const manifest = installRuntime({
    runtimeDir,
    sourceDir: source,
    version: VERSION,
    platform: 'win32-x64',
    executable: 'Godot.exe',
    sourceExecutable: 'Godot_v4.7.2-stable_win64.exe',
  });

  assert.deepEqual(manifest, {
    version: VERSION,
    platform: 'win32-x64',
    directory: '4.7.2-stable-win32-x64',
    executable: '4.7.2-stable-win32-x64/Godot.exe',
  });
  assert.equal(
    readFileSync(join(runtimeDir, manifest.executable), 'utf8'),
    'binary',
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(runtimeDir, 'runtime.json'), 'utf8')),
    manifest,
  );
  assert.deepEqual(readRuntimeManifest(runtimeDir), manifest);
  assert.equal(isRuntimeInstalled(runtimeDir, VERSION, 'win32-x64'), true);
  assert.equal(isRuntimeInstalled(runtimeDir, VERSION, 'linux-x64'), false);
});

test('removes an incomplete install when the executable is missing', () => {
  const root = tempDir();
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  const runtimeDir = join(root, 'godot_runtime');

  assert.throws(
    () =>
      installRuntime({
        runtimeDir,
        sourceDir: source,
        version: VERSION,
        platform: 'win32-x64',
        executable: 'Godot.exe',
        sourceExecutable: 'Godot_v4.7.2-stable_win64.exe',
      }),
    /Godot_v4.7.2-stable_win64\.exe/,
  );
  assert.equal(readRuntimeManifest(runtimeDir), null);
});

test('resolves the executable from an installed runtime manifest', () => {
  const root = tempDir();
  const runtimeDir = join(root, 'godot_runtime');
  const directory = '4.7.2-stable-win32-x64';
  mkdirSync(join(runtimeDir, directory), { recursive: true });
  const executable = join(runtimeDir, directory, 'Godot.exe');
  writeFileSync(executable, '');
  writeFileSync(
    join(runtimeDir, 'runtime.json'),
    JSON.stringify({
      version: VERSION,
      platform: 'win32-x64',
      directory,
      executable: `${directory}/Godot.exe`,
    }),
  );

  assert.equal(resolveRuntimeExecutable(runtimeDir), executable);
  rmSync(executable);
  assert.equal(resolveRuntimeExecutable(runtimeDir), '');
});

test('ignores a manifest whose executable disappeared', () => {
  const root = tempDir();
  const runtimeDir = join(root, 'godot_runtime');
  const directory = '4.7.2-stable-linux-x64';
  mkdirSync(join(runtimeDir, directory), { recursive: true });
  writeFileSync(
    join(runtimeDir, 'runtime.json'),
    JSON.stringify({
      version: VERSION,
      platform: 'linux-x64',
      directory,
      executable: `${directory}/godot`,
    }),
  );

  assert.equal(isRuntimeInstalled(runtimeDir, VERSION, 'linux-x64'), false);
});
