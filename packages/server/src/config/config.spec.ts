import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import config from './config';

describe('config paths', () => {
  const original = process.env.GODOT_EDITOR_PATH;
  const originalReadSecret = process.env.WIRED_PACKAGE_READ_SECRET;
  const originalReadTtl = process.env.WIRED_PACKAGE_READ_TTL_SEC;
  const originalTicketSecret = process.env.WIRED_GAME_TICKET_SECRET;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.GODOT_EDITOR_PATH;
    } else {
      process.env.GODOT_EDITOR_PATH = original;
    }
    if (originalReadSecret === undefined) {
      delete process.env.WIRED_PACKAGE_READ_SECRET;
    } else {
      process.env.WIRED_PACKAGE_READ_SECRET = originalReadSecret;
    }
    if (originalReadTtl === undefined) {
      delete process.env.WIRED_PACKAGE_READ_TTL_SEC;
    } else {
      process.env.WIRED_PACKAGE_READ_TTL_SEC = originalReadTtl;
    }
    if (originalTicketSecret === undefined) {
      delete process.env.WIRED_GAME_TICKET_SECRET;
    } else {
      process.env.WIRED_GAME_TICKET_SECRET = originalTicketSecret;
    }
  });

  it('reads the package read secret and ttl from the environment', () => {
    process.env.WIRED_PACKAGE_READ_SECRET = 'read-secret';
    process.env.WIRED_PACKAGE_READ_TTL_SEC = '120';

    expect(config().packages).toEqual({
      readSecret: 'read-secret',
      readTtlSec: 120,
    });
  });

  it('falls back to WIRED_GAME_TICKET_SECRET for the read secret', () => {
    delete process.env.WIRED_PACKAGE_READ_SECRET;
    process.env.WIRED_GAME_TICKET_SECRET = 'shared-secret';

    expect(config().packages.readSecret).toBe('shared-secret');
  });

  it('keeps an empty read secret when neither variable is set', () => {
    delete process.env.WIRED_PACKAGE_READ_SECRET;
    delete process.env.WIRED_GAME_TICKET_SECRET;

    expect(config().packages.readSecret).toBe('');
  });

  it('resolves filesystem paths once, independently of the caller cwd', () => {
    process.env.GODOT_EDITOR_PATH = './custom-editor';

    expect(config().godot.editorPath).toBe(resolve('./custom-editor'));
    expect(config().godotRuntime.stateDir).toBe(
      resolve(process.env.GODOT_ROOM_STATE_DIR ?? './storage/godot_rooms'),
    );
  });

  it('uses the downloaded runtime when GODOT_RUNTIME_PATH is unset', () => {
    const originalRuntime = process.env.GODOT_RUNTIME_PATH;
    const originalCwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), 'wired-config-'));
    const directory = '4.7.2-stable-win32-x64';
    try {
      mkdirSync(join(root, 'godot_runtime', directory), { recursive: true });
      writeFileSync(join(root, 'godot_runtime', directory, 'Godot.exe'), '');
      writeFileSync(
        join(root, 'godot_runtime', 'runtime.json'),
        JSON.stringify({
          version: '4.7.2-stable',
          platform: 'win32-x64',
          directory,
          executable: `${directory}/Godot.exe`,
        }),
      );

      delete process.env.GODOT_RUNTIME_PATH;
      process.chdir(root);

      expect(config().godotRuntime.executablePath).toBe(
        join(root, 'godot_runtime', directory, 'Godot.exe'),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
      if (originalRuntime === undefined) {
        delete process.env.GODOT_RUNTIME_PATH;
      } else {
        process.env.GODOT_RUNTIME_PATH = originalRuntime;
      }
    }
  });
});
