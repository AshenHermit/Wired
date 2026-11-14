# Editor Brotli Sidecars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /godot-editor/*` serves precompressed brotli sidecars to clients that ask for them (`Accept-Encoding: br`) and revalidates with ETag, so room opens stop re-downloading the ~40 MB editor tree.

**Architecture:** `pnpm fetch:editor` (and a boot-time backfill) writes `<file>.br` sidecars next to the installed editor files (build-time, quality 11, only when smaller). `serveStaticAsset` gains a `precompressed` option: negotiate via `Accept-Encoding`, serve the sidecar with `Content-Encoding: br` but the original path's Content-Type, fall back to raw otherwise. Only the editor route opts in.

**Tech Stack:** Node built-ins only (`node:zlib` brotli, `node:child_process` for the boot backfill). No new npm dependencies, no new env vars.

**Spec:** `docs/superpowers/specs/2026-11-14-editor-brotli-design.md` (approved).

## File Structure

- Create `packages/server/scripts/lib/editor-brotli.mjs` — sidecar builder lib + CLI (single source of truth for creation rules: `.br` suffix, 1 KB threshold, quality 11, mtime freshness, "sidecar must be smaller").
- Create `packages/server/scripts/lib/editor-brotli.test.mjs` — node --test suite, including a spawn of `fetch-godot-editor.mjs` against a fake installed tree.
- Modify `packages/server/scripts/lib/editor-install.mjs` — export the existing private `listFiles` for reuse.
- Modify `packages/server/scripts/fetch-godot-editor.mjs` — build sidecars after install and backfill on the already-installed early exit.
- Create `packages/server/src/common/static-assets.spec.ts` — unit tests for negotiation/304.
- Modify `packages/server/src/common/static-assets.ts` — `precompressed` option + `acceptsBrotli` + negotiation in `serveStaticAsset`.
- Modify `packages/server/src/godot-editor-provider/godot-editor-provider.controller.ts` — `getEditorFile` opts into `precompressed: true, revalidate: true`.
- Modify `packages/server/src/godot-editor-provider/godot-editor-provider.controller.spec.ts` — HTTP-level brotli + 304 tests.
- Create `packages/server/src/common/editor-sidecar-backfill.ts` + spec — boot-time spawn of the CLI (fire-and-forget).
- Modify `packages/server/src/main.ts` — one fire-and-forget call.
- Modify `AGENTS.md` — one line about sidecars near `fetch:editor`.

## Global Constraints

- No new npm dependencies and no new env vars (design: «Новых зависимостей и env-переменных нет»).
- Only the `godot-editor/*` route gets `precompressed`. Never enable it for `godot-project/*`, `game-export/*`, media, or any endpoint Godot reads — `Content-Encoding` breaks Godot's HTTPRequest (comment in `package-delivery.controller.ts`).
- `Content-Type` is always computed from the ORIGINAL path, never from `<file>.br` (otherwise `application/wasm` degrades to octet-stream and `instantiateStreaming` fails).
- Sidecar freshness rule (shared by builder and server): sidecar exists AND `mtimeMs(.br) >= mtimeMs(raw)`.
- Sidecars live only inside the gitignored `packages/server/godot_editor/` tree (or `GODOT_EDITOR_PATH`); never write any into committed `godot_project/_wired/`.
- Scripts (`scripts/lib/*.mjs`) use only Node built-ins (Node >= 22) and log in Russian, prefixed like neighbors (`[fetch:editor]` style).
- Server code style: Prettier single quotes + trailing commas; Conventional Commits.
- Test conventions: Jest specs co-located as `src/**/*.spec.ts`; script tests as `scripts/lib/*.test.mjs` under `node --test` (`pnpm --filter server test:scripts`).

## Review Focus

- `Accept-Encoding: br;q=0` (and bare `*`) must serve RAW, never brotli — pinned by Task 3 step 1 test "does not negotiate brotli for refused encodings".
- Cold tree / missing sidecar (before any fetch:editor or backfill) must serve raw with no `Content-Encoding` — pinned by Task 3 step 1 test "falls back to raw when no fresh sidecar exists".
- Stale sidecar after an editor re-pin (sidecar mtime < raw mtime) must serve raw until rebuilt — pinned by Task 3 step 1 test "ignores a stale sidecar" and Task 1 step 1 test "recompresses a stale sidecar".
- Incompressible file must not produce a sidecar, and a leftover oversized sidecar must be removed — pinned by Task 1 step 1 test "drops an oversized sidecar for incompressible content".
- `If-None-Match` revalidation must key on the actually-served representation (raw vs sidecar) — pinned by Task 3 step 1 test "answers 304 from the served representation" and Task 4 step 1 HTTP test.

---

### Task 1: Sidecar builder lib (`editor-brotli.mjs`)

**Files:**
- Modify: `packages/server/scripts/lib/editor-install.mjs:41` (add `export` to `listFiles`)
- Create: `packages/server/scripts/lib/editor-brotli.mjs`
- Test: `packages/server/scripts/lib/editor-brotli.test.mjs`

**Interfaces:**
- Consumes: `listFiles(dir, prefix?)` from `./editor-install.mjs` (exported in this task; returns sorted relative names with `/` separators).
- Produces (used by Tasks 2 and 5):
  - `compressEditorSidecars({ dir: string, minBytes?: number = 1024, log?: (message: string) => void }): { written: string[], savedBytes: number }` — walks `dir`, for every file ≥ `minBytes` whose sidecar is missing or stale writes `<file>.br` (brotli quality 11) when strictly smaller; removes an existing sidecar when the content is incompressible (compressed ≥ raw); skips `*.br` files themselves. Idempotent via the freshness rule.
  - `SIDECAR_SUFFIX = '.br'`, `MIN_RAW_BYTES = 1024`.
  - CLI: `node editor-brotli.mjs <editorDir>` — exits 0 with a summary line, 1 on error (bad usage, missing dir).

- [ ] **Step 1: Write the failing tests**

Create `packages/server/scripts/lib/editor-brotli.test.mjs` in the style of `editor-install.test.mjs` (temp-root helper, `node:assert/strict`, `node:test`):

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';

import { compressEditorSidecars } from './editor-brotli.mjs';

const BIG = 'x'.repeat(64 * 1024);

function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'wired-editor-brotli-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
```

Tests (assert sidecars decompress back to the raw bytes with `brotliDecompressSync`):

1. `creates sidecars above the size threshold, including subdirectories` — write `godot.editor.wasm` = BIG, `assets/font.woff2` = BIG, `tiny.txt` = `'hi'`; run; expect `written` sorted to equal `['assets/font.woff2', 'godot.editor.wasm']`, both sidecars exist and decompress to BIG, no `tiny.txt.br`.
2. `applies the size threshold` — write a 20-byte file; default `minBytes` → `written` empty and no sidecar; re-run with `{ minBytes: 1 }` → sidecar written.
3. `drops an oversized sidecar for incompressible content` — write `noise.bin` = `randomBytes(8192)` and a pre-existing junk `noise.bin.br` of 9999 random bytes; run; expect `written` empty and `noise.bin.br` removed.
4. `recompresses a stale sidecar` — write `godot.editor.js` = BIG and a junk sidecar; backdate the raw file with `utimesSync(raw, past, past)` where `past` = `statSync(raw).mtimeMs - 5000`; run; expect `written` `['godot.editor.js']` and the sidecar now decompresses to BIG.
5. `backfill is idempotent` — one BIG file; run twice; the second run returns `written` empty.
6. `CLI writes sidecars and exits 0` — `spawnSync(process.execPath, [resolve('scripts/lib/editor-brotli.mjs'), dir], { cwd: <packages/server>, encoding: 'utf8' })` on a temp dir with a BIG file; expect exit 0 and the sidecar on disk. (Run with `cwd` = the server package root, e.g. `resolve(import.meta.dirname, '..', '..)`.)
7. `fetch:editor backfills sidecars on the already-installed early exit` — temp `dest` dir containing `VERSION` = `'4.8-beta2\n'` plus the three core files `godot.editor.js/.wasm/.html` = BIG; `spawnSync(process.execPath, [resolve('scripts/fetch-godot-editor.mjs')], { cwd: resolve(import.meta.dirname, '..', '..'), env: { ...process.env, GODOT_EDITOR_PATH: dest }, encoding: 'utf8' })` (`import.meta.dirname` = `scripts/lib`, so cwd = the server package root, where the fetch script resolves `scripts/...` imports); expect exit 0 (assert with `result.stderr` in the message) and `godot.editor.wasm.br` present. No network is touched: the fake install short-circuits at `isEditorInstalled`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec node --test scripts/lib/editor-brotli.test.mjs`
Expected: FAIL — cannot import `./editor-brotli.mjs` (module not found).

- [ ] **Step 3: Export `listFiles` from `editor-install.mjs`**

Change `function listFiles(dir, prefix = '')` (line 41) to `export function listFiles(...)` and add a one-line doc comment ("Sorted relative file paths under `dir`, `/`-separated; reused by the sidecar builder."). No behavior change.

- [ ] **Step 4: Implement `packages/server/scripts/lib/editor-brotli.mjs`**

Header comment in the style of `editor-install.mjs` ("Only Node built-ins"). Imports: `path`, `brotliCompressSync, constants` from `node:zlib`, `pathToFileURL` from `node:url`, fs helpers, `listFiles` from `./editor-install.mjs`.

```js
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
```

CLI guard at the bottom (runs only when executed directly, never under `node --test`):

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter server exec node --test scripts/lib/editor-brotli.test.mjs`
Expected: PASS (all 7 tests; the fetch-script test must not attempt any download).

- [ ] **Step 6: Commit**

```bash
git add packages/server/scripts/lib/editor-install.mjs packages/server/scripts/lib/editor-brotli.mjs packages/server/scripts/lib/editor-brotli.test.mjs
git commit -m "feat(server): brotli sidecar builder for the editor tree"
```

---

### Task 2: Build sidecars in `fetch:editor`

**Files:**
- Modify: `packages/server/scripts/fetch-godot-editor.mjs:27-32` (import), `:89-93` (early exit), `:110-112` (after install)

**Interfaces:**
- Consumes: `compressEditorSidecars({ dir })` from `./lib/editor-brotli.mjs` (Task 1).
- Produces: nothing exported — running `pnpm fetch:editor` now leaves fresh sidecars in the install dir, in both the fresh-install and already-installed paths. Failures propagate (script exits non-zero): a broken install must fail CI, same philosophy as `assertCoreFiles`.

- [ ] **Step 1: Add the import and a `backfillSidecars()` helper**

```js
import { compressEditorSidecars } from './lib/editor-brotli.mjs';
```

```js
function backfillSidecars() {
  const { written, savedBytes } = compressEditorSidecars({ dir: destDir });
  log(
    written.length
      ? `Sidecars: создано ${written.length} (сэкономлено ${(savedBytes / 1024 / 1024).toFixed(2)} MiB)`
      : 'Sidecars: актуальны',
  );
}
```

- [ ] **Step 2: Call it on the already-installed early exit (backfill before the return)**

```js
if (!force && isEditorInstalled({ destDir, version: VERSION, log })) {
  log(`Редактор уже на ${VERSION}`);
  backfillSidecars();
  return;
}
```

- [ ] **Step 3: Call it after a fresh install**

After `assertCoreFiles(destDir);` (before the `Готово` log), add `backfillSidecars();`.

- [ ] **Step 4: Verify**

Run: `node --check packages/server/scripts/fetch-godot-editor.mjs` then `pnpm --filter server test:scripts`
Expected: syntax OK; all script tests PASS — including Task 1's test 7, which now exercises the real early-exit wiring.

- [ ] **Step 5: Commit**

```bash
git add packages/server/scripts/fetch-godot-editor.mjs
git commit -m "feat(server): build editor .br sidecars in fetch:editor"
```

---

### Task 3: `precompressed` negotiation in `serveStaticAsset`

**Files:**
- Create: `packages/server/src/common/static-assets.spec.ts`
- Modify: `packages/server/src/common/static-assets.ts:29-40` (options interface), `:60-108` (function body)

**Interfaces:**
- Produces (used by Task 4):
  - `StaticAssetOptions.precompressed?: boolean` — default `false`; when true, `Vary: Accept-Encoding` is always sent and a fresh `<file>.br` sidecar is served with `Content-Encoding: br` when the client accepts brotli.
  - `acceptsBrotli(header: string | undefined): boolean` (exported for tests) — case-insensitive token match on comma-separated items; `;q=` value parsed with `parseFloat`, `q=0` refuses; a bare `*` is NOT treated as brotli; last occurrence wins on duplicates.
  - Behavior contract: `Vary` set before the 304 short-circuit (caches must key on it even for 304s); `Content-Encoding` set only on a real 200 sidecar response; ETag/`Content-Length` computed from the file actually served (raw or sidecar); the shell (`noStoreShell`) check still uses the original extension.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/common/static-assets.spec.ts`. Helpers mirroring `godot-editor-provider.controller.spec.ts`:

```ts
import { NotFoundException, StreamableFile } from '@nestjs/common';
import { Request, Response } from 'express';
import { mkdtemp, writeFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'stream';
import { brotliCompressSync } from 'node:zlib';
import { acceptsBrotli, serveStaticAsset } from './static-assets';

function fakeRequest(acceptEncoding?: string): Request {
  return {
    headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
  } as unknown as Request;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    set: jest.fn((values: Record<string, string>) => Object.assign(headers, values)),
    status: jest.fn(() => res),
  };
  return { res: res as unknown as Response, headers };
}

async function readBody(file: StreamableFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream() as unknown as Readable) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
```

Spec `describe('serveStaticAsset')` — each test makes a temp root with raw `godot.editor.wasm` = `'raw-wasm-payload'` and, where needed, a sidecar `${raw}.br` = `brotliCompressSync(Buffer.from('raw-wasm-payload'))`:

1. `serves raw when the option is off` — no options, `accept-encoding: br` → no `Vary`, no `Content-Encoding`, body = raw bytes.
2. `serves a fresh sidecar with the original content type` — `{ precompressed: true }`, `accept-encoding: 'br'` → `Content-Encoding: 'br'`, `Content-Type: 'application/wasm'` (from the original path, not `.br`), `Vary: 'Accept-Encoding'`, body = the sidecar bytes.
3. `falls back to raw when no sidecar exists` — no `.br` on disk → no `Content-Encoding`, body = raw, `Vary` still `'Accept-Encoding'`.
4. `ignores a stale sidecar` — sidecar on disk but `utimes(raw, future, future)` (+5000 ms) → body = raw, no `Content-Encoding`.
5. `does not negotiate brotli for refused encodings` — iterate `'br;q=0'`, `'gzip'`, `undefined`, `'*'` → no `Content-Encoding` and body = raw each time (brotli still accepted for `'BR'`, `'br;q=0.8'`, `'gzip, deflate, br'` — assert via a loop that those DO set `Content-Encoding: 'br'`).
6. `answers 304 from the served representation` — `{ precompressed: true, revalidate: true }`; first call returns a file and an `ETag`; second call with `If-None-Match: <that etag>` → returns `undefined`, `res.status` called with 304, and no `Content-Encoding` in the response headers.
7. `returns 404 for a missing file` — expect the promise to reject with `NotFoundException` (guards the untouched traversal/404 behavior).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec jest static-assets`
Expected: FAIL — `acceptsBrotli` is not exported / `precompressed` unknown option.

- [ ] **Step 3: Implement in `static-assets.ts`**

Add to `StaticAssetOptions`:

```ts
  /** Offer fresh `<file>.br` sidecars to clients that accept brotli. */
  precompressed?: boolean;
```

Add the exported parser next to `matchesEtag`:

```ts
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
```

Rewrite the body of `serveStaticAsset` (destructure gains `precompressed = false`); the ordering below is the contract — `Vary` before the 304 short-circuit, `Content-Encoding` after it:

```ts
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

  return new StreamableFile(createReadStream(servedPath), { length: servedSize });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server exec jest static-assets` then `pnpm --filter server test`
Expected: new spec PASS; full server suite still green (default off → no other route changes).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/common/static-assets.ts packages/server/src/common/static-assets.spec.ts
git commit -m "feat(server): precompressed sidecar support in serveStaticAsset"
```

---

### Task 4: Opt the editor route in

**Files:**
- Modify: `packages/server/src/godot-editor-provider/godot-editor-provider.controller.ts:37-42`
- Modify: `packages/server/src/godot-editor-provider/godot-editor-provider.controller.spec.ts`

**Interfaces:**
- Consumes: `StaticAssetOptions.precompressed` (Task 3).
- Produces: `getEditorFile` passes `{ precompressed: true, revalidate: true }`; the other two handlers in this controller stay option-free/unchanged.

- [ ] **Step 1: Extend the controller spec first (failing tests)**

In `godot-editor-provider.controller.spec.ts` `beforeAll`, after the existing `engine.js` write, add a precompressed fixture (spec-local zlib import is fine; sidecar content is arbitrary brotli bytes of the same payload):

```ts
import { brotliCompressSync } from 'node:zlib';
// ...
const bigPayload = Buffer.from('x'.repeat(4096));
await writeFile(path.join(workspace, 'editor', 'big.js'), bigPayload);
await writeFile(
  path.join(workspace, 'editor', 'big.js.br'),
  brotliCompressSync(bigPayload),
);
```

Add two tests to the existing `describe('HTTP wildcard routing')`:

```ts
it('serves a precompressed sidecar to brotli clients', async () => {
  const app = await createApp();
  try {
    const response = await request(app.getHttpServer())
      .get('/godot-editor/big.js')
      .set('Accept-Encoding', 'br')
      .expect(200);
    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers['vary']).toContain('Accept-Encoding');
  } finally {
    await app.close();
  }
});

it('revalidates the editor file with an ETag', async () => {
  const app = await createApp();
  try {
    const first = await request(app.getHttpServer())
      .get('/godot-editor/big.js')
      .expect(200);
    expect(first.headers.etag).toBeDefined();
    await request(app.getHttpServer())
      .get('/godot-editor/big.js')
      .set('If-None-Match', first.headers.etag)
      .expect(304);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter server exec jest godot-editor-provider`
Expected: FAIL — no `Content-Encoding`/`ETag` headers yet.

- [ ] **Step 3: Update `getEditorFile`**

```ts
    return serveStaticAsset(
      resolve(this.configService.godot.editorPath),
      wildcardPath(requestedPath),
      req,
      res,
      {
        // Browsers decompress brotli themselves and Godot's runtime never
        // reads these files, so sidecars are safe here and only here.
        precompressed: true,
        // The editor tree is ~40 MB; revalidate instead of re-downloading.
        revalidate: true,
      },
    );
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter server exec jest godot-editor-provider`
Expected: PASS — all existing tests (traversal, project files, raw `engine.js` body) unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/godot-editor-provider/godot-editor-provider.controller.ts packages/server/src/godot-editor-provider/godot-editor-provider.controller.spec.ts
git commit -m "feat(server): enable brotli and revalidation for godot-editor assets"
```

---

### Task 5: Boot backfill

**Files:**
- Create: `packages/server/src/common/editor-sidecar-backfill.ts`
- Create: `packages/server/src/common/editor-sidecar-backfill.spec.ts`
- Modify: `packages/server/src/main.ts:15` (import) and after `app.enableShutdownHooks();` (call)

**Interfaces:**
- Consumes: the `editor-brotli.mjs` CLI (Task 1) via `spawn(process.execPath, [scriptPath, editorPath])`.
- Produces: `backfillEditorSidecars(editorPath: string, scriptPath: string = resolve('scripts/lib/editor-brotli.mjs')): Promise<void> | undefined` — exported from `packages/server/src/common/editor-sidecar-backfill.ts`. Returns `undefined` (and does nothing) when the editor dir or the script file does not exist (production images bake sidecars at build time and don't ship `scripts/`); otherwise a promise that settles when the child exits, never rejects, warns on non-zero exit.

- [ ] **Step 1: Write the failing spec**

`packages/server/src/common/editor-sidecar-backfill.spec.ts`:

```ts
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { existsSync, readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { backfillEditorSidecars } from './editor-sidecar-backfill';

describe('backfillEditorSidecars', () => {
  it('does nothing when the script is not on disk', () => {
    expect(backfillEditorSidecars('nowhere', 'missing-editor-brotli.mjs')).toBeUndefined();
  });

  it('rebuilds missing sidecars through the script CLI', async () => {
    const editorPath = await mkdtemp(path.join(tmpdir(), 'wired-backfill-'));
    const raw = path.join(editorPath, 'godot.editor.wasm');
    await writeFile(raw, 'x'.repeat(4096));

    await backfillEditorSidecars(editorPath);

    const sidecar = `${raw}.br`;
    expect(existsSync(sidecar)).toBe(true);
    expect(brotliDecompressSync(readFileSync(sidecar)).toString()).toBe(
      'x'.repeat(4096),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter server exec jest editor-sidecar-backfill`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `editor-sidecar-backfill.ts`**

```ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_PATH = 'scripts/lib/editor-brotli.mjs';

/**
 * Rebuilds missing/stale `.br` sidecars for the installed editor by running
 * the same CLI `fetch:editor` uses. Runs as a child process because
 * `brotliCompressSync` on the wasm blob blocks for seconds — never on the
 * Nest event loop. Skips silently when the script is not on disk (production
 * images bake sidecars at build time and don't ship `scripts/`). Until the
 * backfill finishes, the editor is served raw; a failed backfill keeps it
 * raw forever.
 */
export function backfillEditorSidecars(
  editorPath: string,
  scriptPath: string = resolve(SCRIPT_PATH),
): Promise<void> | undefined {
  if (!existsSync(editorPath) || !existsSync(scriptPath)) {
    return undefined;
  }
  return new Promise((settle) => {
    const child = spawn(process.execPath, [scriptPath, editorPath], {
      stdio: 'ignore',
    });
    child.on('error', () => settle());
    child.on('close', (code) => {
      if (code !== 0) {
        console.warn(
          `[editor-sidecars] backfill exited with ${code}; the editor stays raw`,
        );
      }
      settle();
    });
  });
}
```

- [ ] **Step 4: Call it from `main.ts`**

Import next to the other common imports, then insert after `app.enableShutdownHooks();`:

```ts
  // Old dev installs that never reran `fetch:editor` still get brotli: the
  // missing `.br` sidecars are rebuilt in the background; until then the
  // editor is served raw.
  void backfillEditorSidecars(appConfig.godot.editorPath);
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter server exec jest editor-sidecar-backfill` then `pnpm --filter server check-types`
Expected: PASS; types clean.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/common/editor-sidecar-backfill.ts packages/server/src/common/editor-sidecar-backfill.spec.ts packages/server/src/main.ts
git commit -m "feat(server): rebuild editor brotli sidecars on boot"
```

---

### Task 6: Docs + full verification

**Files:**
- Modify: `AGENTS.md` (Commands section, the `pnpm fetch:editor` line)

- [ ] **Step 1: Mention sidecars in AGENTS.md**

Change the comment on the `fetch:editor` line to:
`pnpm fetch:editor                        # pinned 4.8-beta2 web editor + .br sidecars (gitignored)`

- [ ] **Step 2: Full verification**

Run: `pnpm --filter server test:scripts && pnpm --filter server test && pnpm --filter server check-types && pnpm --filter server lint`
Expected: all script tests pass; server suite green (was 76 suites / 916 tests, now +2 jest suites: `static-assets.spec.ts`, `editor-sidecar-backfill.spec.ts`); types and lint clean. Frontend is untouched — no need to run it.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: mention editor brotli sidecars in AGENTS.md"
```
