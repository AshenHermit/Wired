import { NotFoundException, StreamableFile } from '@nestjs/common';
import { Request, Response } from 'express';
import { mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'stream';
import { brotliCompressSync } from 'node:zlib';
import {
  acceptsBrotli,
  serveStaticAsset,
  StaticAssetOptions,
} from './static-assets';

const RAW_BODY = 'raw-wasm-payload';
const SIDECAR_BODY = brotliCompressSync(Buffer.from(RAW_BODY));

function fakeRequest(acceptEncoding?: string): Request {
  return {
    headers:
      acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
  } as unknown as Request;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  const status = jest.fn((): void => undefined);
  const res: { set: jest.Mock; status: jest.Mock } = {
    set: jest.fn((values: Record<string, string>) =>
      Object.assign(headers, values),
    ),
    status,
  };
  return { res: res as unknown as Response, headers, status };
}

async function readBody(file: StreamableFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream() as unknown as Readable) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'wired-static-assets-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Writes the raw wasm file and, optionally, its fresh sidecar. */
async function writeAsset(root: string, withSidecar: boolean): Promise<string> {
  const raw = path.join(root, 'godot.editor.wasm');
  await writeFile(raw, RAW_BODY);
  if (withSidecar) {
    await writeFile(`${raw}.br`, SIDECAR_BODY);
  }
  return raw;
}

async function serve(
  root: string,
  acceptEncoding?: string,
  options?: StaticAssetOptions,
) {
  const { res, headers } = fakeResponse();
  return {
    headers,
    res,
    result: await serveStaticAsset(
      root,
      'godot.editor.wasm',
      fakeRequest(acceptEncoding),
      res,
      options,
    ),
  };
}

describe('acceptsBrotli', () => {
  it('accepts explicit brotli tokens', () => {
    expect(acceptsBrotli('br')).toBe(true);
    expect(acceptsBrotli('BR')).toBe(true);
    expect(acceptsBrotli('gzip, deflate, br')).toBe(true);
    expect(acceptsBrotli('br;q=0.8')).toBe(true);
  });

  it('refuses zero quality, wildcards and missing headers', () => {
    expect(acceptsBrotli('br;q=0')).toBe(false);
    expect(acceptsBrotli('gzip;q=1.0, br;q=0')).toBe(false);
    expect(acceptsBrotli('*')).toBe(false);
    expect(acceptsBrotli('gzip')).toBe(false);
    expect(acceptsBrotli(undefined)).toBe(false);
  });
});

describe('serveStaticAsset', () => {
  it('serves raw when the option is off', async () => {
    await withTempRoot(async (root) => {
      await writeAsset(root, true);

      const { headers, result } = await serve(root, 'br');

      expect(headers['Content-Encoding']).toBeUndefined();
      expect(headers.Vary).toBeUndefined();
      expect(await readBody(result as StreamableFile)).toEqual(
        Buffer.from(RAW_BODY),
      );
    });
  });

  it('serves a fresh sidecar with the original content type', async () => {
    await withTempRoot(async (root) => {
      await writeAsset(root, true);

      const { headers, result } = await serve(root, 'br', {
        precompressed: true,
      });

      expect(headers['Content-Encoding']).toBe('br');
      // From the original path, not from `<file>.br` (which is octet-stream).
      expect(headers['Content-Type']).toBe('application/wasm');
      expect(headers.Vary).toBe('Accept-Encoding');
      expect(await readBody(result as StreamableFile)).toEqual(SIDECAR_BODY);
    });
  });

  it('falls back to raw when no sidecar exists', async () => {
    await withTempRoot(async (root) => {
      await writeAsset(root, false);

      const { headers, result } = await serve(root, 'br', {
        precompressed: true,
      });

      expect(headers['Content-Encoding']).toBeUndefined();
      expect(headers.Vary).toBe('Accept-Encoding');
      expect(await readBody(result as StreamableFile)).toEqual(
        Buffer.from(RAW_BODY),
      );
    });
  });

  it('ignores a stale sidecar', async () => {
    await withTempRoot(async (root) => {
      const raw = await writeAsset(root, true);
      // The sidecar is older than the raw file: the editor was re-pinned.
      const future = new Date(Date.now() + 5000);
      await utimes(raw, future, future);

      const { headers, result } = await serve(root, 'br', {
        precompressed: true,
      });

      expect(headers['Content-Encoding']).toBeUndefined();
      expect(await readBody(result as StreamableFile)).toEqual(
        Buffer.from(RAW_BODY),
      );
    });
  });

  it('does not negotiate brotli for refused encodings', async () => {
    await withTempRoot(async (root) => {
      await writeAsset(root, true);

      for (const refused of ['br;q=0', 'gzip', undefined, '*']) {
        const { headers, result } = await serve(root, refused, {
          precompressed: true,
        });
        expect(headers['Content-Encoding']).toBeUndefined();
        expect(await readBody(result as StreamableFile)).toEqual(
          Buffer.from(RAW_BODY),
        );
      }

      for (const accepted of ['BR', 'br;q=0.8', 'gzip, deflate, br']) {
        const { headers, result } = await serve(root, accepted, {
          precompressed: true,
        });
        expect(headers['Content-Encoding']).toBe('br');
        expect(await readBody(result as StreamableFile)).toEqual(SIDECAR_BODY);
      }
    });
  });

  it('answers 304 from the served representation', async () => {
    await withTempRoot(async (root) => {
      await writeAsset(root, true);

      const first = await serve(root, 'br', {
        precompressed: true,
        revalidate: true,
      });
      const file = first.result as StreamableFile;
      expect(first.headers['Content-Encoding']).toBe('br');
      const etag = first.headers.ETag;
      expect(etag).toBeDefined();
      expect(await readBody(file)).toEqual(SIDECAR_BODY);

      const second = fakeResponse();
      const revalidated = await serveStaticAsset(
        root,
        'godot.editor.wasm',
        {
          headers: {
            'accept-encoding': 'br',
            'if-none-match': etag,
          },
        } as unknown as Request,
        second.res,
        { precompressed: true, revalidate: true },
      );
      expect(revalidated).toBeUndefined();
      expect(second.status).toHaveBeenCalledWith(304);
      expect(second.headers['Content-Encoding']).toBeUndefined();
    });
  });

  it('returns 404 for a missing file', async () => {
    await withTempRoot(async (root) => {
      const { res } = fakeResponse();
      await expect(
        serveStaticAsset(root, 'missing.txt', fakeRequest('br'), res, {
          precompressed: true,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
