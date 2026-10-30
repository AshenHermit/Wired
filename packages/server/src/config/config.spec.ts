import { resolve } from 'node:path';
import config from './config';

describe('config paths', () => {
  const original = process.env.GODOT_EDITOR_PATH;
  const originalReadSecret = process.env.WIRED_PACKAGE_READ_SECRET;
  const originalReadTtl = process.env.WIRED_PACKAGE_READ_TTL_SEC;

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
  });

  it('reads the package read secret and ttl from the environment', () => {
    process.env.WIRED_PACKAGE_READ_SECRET = 'read-secret';
    process.env.WIRED_PACKAGE_READ_TTL_SEC = '120';

    expect(config().packages).toEqual({
      readSecret: 'read-secret',
      readTtlSec: 120,
    });
  });

  it('resolves filesystem paths once, independently of the caller cwd', () => {
    process.env.GODOT_EDITOR_PATH = './custom-editor';

    expect(config().godot.editorPath).toBe(resolve('./custom-editor'));
    expect(config().godotRuntime.stateDir).toBe(
      resolve(process.env.GODOT_ROOM_STATE_DIR ?? './storage/godot_rooms'),
    );
  });
});
