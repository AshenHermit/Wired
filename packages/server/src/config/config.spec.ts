import { resolve } from 'node:path';
import config from './config';

describe('config paths', () => {
  const original = process.env.GODOT_EDITOR_PATH;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.GODOT_EDITOR_PATH;
    } else {
      process.env.GODOT_EDITOR_PATH = original;
    }
  });

  it('resolves filesystem paths once, independently of the caller cwd', () => {
    process.env.GODOT_EDITOR_PATH = './custom-editor';

    expect(config().godot.editorPath).toBe(resolve('./custom-editor'));
    expect(config().godotRuntime.stateDir).toBe(
      resolve(process.env.GODOT_ROOM_STATE_DIR ?? './storage/godot_rooms'),
    );
  });
});
