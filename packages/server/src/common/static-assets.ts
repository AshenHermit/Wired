import { NotFoundException, StreamableFile } from '@nestjs/common';
import { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { contentTypeFor } from './content-types';
import { resolveWithin } from './paths';

const SHELL_EXTENSIONS = new Set(['.html', '.htm']);

/**
 * The cross-origin isolation trio a WASM build needs.
 *
 * `SharedArrayBuffer` only exists for a cross-origin isolated document, and the
 * engine refuses to boot without it. Both the editor and the game export are
 * served by us, so this is the one place that has to remember it.
 */
function setCrossOriginIsolation(res: Response): void {
  res.set({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    // Both trees are same-origin assets; keep them from being embedded
    // elsewhere.
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
}

export interface StaticAssetOptions {
  /** Served when the request path is empty or directory-shaped. */
  defaultFile?: string;
  /** Content type for the resolved file. Defaults to the extension table. */
  contentType?: (filepath: string) => string;
  /** Send a size+mtime validator and answer 304 for a matching If-None-Match. */
  revalidate?: boolean;
  /** Keep the HTML shell uncached so a rebuilt tree is picked up immediately. */
  noStoreShell?: boolean;
  /** Offer fresh `<file>.br` sidecars to clients that accept brotli. */
  precompressed?: boolean;
  /** Add the COOP/COEP trio. Off only for files that are never a document. */
  crossOriginIsolation?: boolean;
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) {
    return false;
  }
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === etag);
}

/**
 * True when the client's Accept-Encoding actually accepts brotli: explicit
 * `br` with a non-zero q. A wildcard `*` is not treated as brotli (browsers
 * list `br` explicitly), and `q=0` refuses even after an earlier acceptance.
 */
export function acceptsBrotli(header: string | undefined): boolean {
  if (!header) {
    return false;
  }
  let accepted = false;
  for (const item of header.split(',')) {
    const [token, ...params] = item.trim().split(';');
    if (token.trim().toLowerCase() !== 'br') {
      continue;
    }
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    accepted = q ? parseFloat(q.slice(2)) > 0 : true;
  }
  return accepted;
}

/**
 * Streams one file out of a directory tree that is served as-is.
 *
 * Every request path is resolved through `resolveWithin`, so a traversal
 * attempt fails before touching the file system. The Content-Type comes from
 * one extension table (`contentTypeFor`) instead of a per-controller copy, and
 * the caller only owns the route prefix and the root directory.
 */
export async function serveStaticAsset(
  root: string,
  relativePath: string,
  req: Request,
  res: Response,
  options: StaticAssetOptions = {},
): Promise<StreamableFile | undefined> {
  const {
    defaultFile = 'index.html',
    contentType = contentTypeFor,
    revalidate = false,
    noStoreShell = false,
    precompressed = false,
    crossOriginIsolation = true,
  } = options;

  let relative = relativePath;
  if (!relative || relative.endsWith('/')) {
    relative += defaultFile;
  }

  const target = resolveWithin(root, relative);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) {
    throw new NotFoundException('File not found');
  }

  // The negotiated representation: raw by default, `<file>.br` when the
  // client accepts brotli and a fresh sidecar exists.
  let servedPath = target;
  let servedSize = info.size;
  let servedMtimeMs = info.mtimeMs;
  let contentEncoding: string | null = null;
  if (precompressed) {
    res.set({ Vary: 'Accept-Encoding' });
    if (acceptsBrotli(req.headers['accept-encoding'])) {
      const sidecarPath = `${target}.br`;
      const sidecar = await stat(sidecarPath).catch(() => null);
      if (sidecar?.isFile() && sidecar.mtimeMs >= info.mtimeMs) {
        servedPath = sidecarPath;
        servedSize = sidecar.size;
        servedMtimeMs = sidecar.mtimeMs;
        contentEncoding = 'br';
      }
    }
  }

  res.set({ 'Content-Type': contentType(target) });
  if (crossOriginIsolation) {
    setCrossOriginIsolation(res);
  }

  let etag: string | null = null;
  if (revalidate) {
    etag = `"${servedSize.toString(16)}-${Math.floor(servedMtimeMs).toString(16)}"`;
    const isShell = SHELL_EXTENSIONS.has(extname(target).toLowerCase());
    // Assets are revalidated instead of re-downloaded on every reconnect (the
    // engine is ~36 MB); the shell itself stays uncached so a fresh build wins.
    res.set({
      'Cache-Control': noStoreShell && isShell ? 'no-store' : 'no-cache',
      ETag: etag,
    });
  }

  if (etag !== null && matchesEtag(req.headers['if-none-match'], etag)) {
    res.status(304);
    return undefined;
  }

  if (contentEncoding !== null) {
    res.set({ 'Content-Encoding': contentEncoding });
  }

  return new StreamableFile(createReadStream(servedPath), {
    length: servedSize,
  });
}

/**
 * Express gives wildcard params either as a string or as an array of segments
 * depending on the router version, so both forms are normalized here.
 */
export function wildcardPath(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value : [value ?? '']).join('/');
}
