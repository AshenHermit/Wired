import { extname } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Content-Type for a streamed file, decided by its extension.
 *
 * Both static artifact servers (the WASM editor and the game export) go through
 * this, so the mapping only has to be right once. An unknown extension falls
 * back to a binary type instead of an absent header: the browser must never
 * guess. `.wasm` in particular has to be `application/wasm`, otherwise the
 * engine refuses to instantiate the module.
 */
export function contentTypeFor(filepath: string): string {
  return (
    CONTENT_TYPES[extname(filepath).toLowerCase()] ?? 'application/octet-stream'
  );
}
