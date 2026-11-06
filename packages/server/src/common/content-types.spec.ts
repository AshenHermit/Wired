import { contentTypeFor } from './content-types';

describe('contentTypeFor', () => {
  it('answers application/wasm for a WebAssembly module', () => {
    // Anything else makes the engine refuse to instantiate the module.
    expect(contentTypeFor('godot.wasm')).toBe('application/wasm');
  });

  it('maps the assets the two static servers actually stream', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('index.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('engine.pck')).toBe('application/octet-stream');
    expect(contentTypeFor('font.woff2')).toBe('font/woff2');
    expect(contentTypeFor('icon.svg')).toBe('image/svg+xml');
  });

  it('ignores the case of the extension', () => {
    expect(contentTypeFor('SPLASH.PNG')).toBe('image/png');
  });

  it('reads only the last extension of a nested path', () => {
    expect(contentTypeFor('/godot-project/wired/assets/hero.gd.map')).toBe(
      'application/json; charset=utf-8',
    );
  });

  it('falls back to a binary type instead of leaving the header absent', () => {
    expect(contentTypeFor('project.godot')).toBe('application/octet-stream');
    expect(contentTypeFor('LICENSE')).toBe('application/octet-stream');
  });
});
