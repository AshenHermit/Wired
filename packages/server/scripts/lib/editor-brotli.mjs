/**
 * Builds precompressed `<file>.br` sidecars next to the installed editor
 * files (quality 11, only when strictly smaller). The server offers a fresh
 * sidecar to clients that accept brotli; freshness is `mtime(.br) >=
 * mtime(raw)`, so a rebuilt editor tree invalidates every sidecar at once.
 *
 * Only Node built-ins are used (Node >= 22).
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

import { listFiles } from './editor-install.mjs';

export const SIDECAR_SUFFIX = '.br';
export const MIN_RAW_BYTES = 1024;

export function compressEditorSidecars({ dir, minBytes = MIN_RAW_BYTES, log = () => {} }) {
  if (!existsSync(dir)) {
    throw new Error(`каталог редактора не найден: ${dir}`);
  }
  const written = [];
  let savedBytes = 0;
  for (const name of listFiles(dir)) {
    if (name.endsWith(SIDECAR_SUFFIX)) continue;
    const rawPath = path.join(dir, name);
    const raw = statSync(rawPath);
    if (raw.size < minBytes) continue;
    const sidecarPath = `${rawPath}${SIDECAR_SUFFIX}`;
    if (existsSync(sidecarPath) && statSync(sidecarPath).mtimeMs >= raw.mtimeMs) {
      continue; // fresh — the server would use it as-is
    }
    const compressed = brotliCompressSync(readFileSync(rawPath), {
      params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
    });
    if (compressed.length >= raw.size) {
      rmSync(sidecarPath, { force: true }); // incompressible: never keep a bigger copy
      continue;
    }
    writeFileSync(sidecarPath, compressed);
    written.push(name);
    savedBytes += raw.size - compressed.length;
  }
  return { written, savedBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const dir = process.argv[2];
    if (!dir) {
      console.error('[editor-brotli] usage: node editor-brotli.mjs <editor-dir>');
      process.exitCode = 1;
    } else {
      const { written, savedBytes } = compressEditorSidecars({ dir });
      console.log(
        `[editor-brotli] создано ${written.length}, сэкономлено ${savedBytes} байт`,
      );
    }
  } catch (error) {
    console.error(`[editor-brotli] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
