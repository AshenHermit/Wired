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

  res.set({ 'Content-Type': contentType(target) });
  if (crossOriginIsolation) {
    setCrossOriginIsolation(res);
  }

  let etag: string | null = null;
  if (revalidate) {
    etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
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

  return new StreamableFile(createReadStream(target), { length: info.size });
}

/**
 * Express gives wildcard params either as a string or as an array of segments
 * depending on the router version, so both forms are normalized here.
 */
export function wildcardPath(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value : [value ?? '']).join('/');
}
