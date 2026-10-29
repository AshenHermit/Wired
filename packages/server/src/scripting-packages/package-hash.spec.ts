import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  isSha256Hex,
  normalizeSha256,
  sha256File,
  sha256Hex,
} from './package-hash';

describe('sha256Hex', () => {
  it('returns the lowercase hex digest of raw bytes', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf8'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes binary data, not its utf8 interpretation', () => {
    expect(sha256Hex(Uint8Array.from([0xff, 0x00, 0x80]))).not.toBe(
      sha256Hex(Buffer.from([0xff, 0x00, 0x80].join(','), 'utf8')),
    );
  });
});

describe('sha256File', () => {
  it('matches sha256Hex for on-disk content', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wired-hash-'));
    const file = path.join(dir, 'hero.bin');
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    writeFileSync(file, bytes);
    try {
      await expect(sha256File(file)).resolves.toBe(sha256Hex(bytes));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('normalizeSha256', () => {
  it('accepts a 64 character digest and lowercases it', () => {
    const upper =
      'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD';
    expect(isSha256Hex(upper)).toBe(true);
    expect(normalizeSha256(upper)).toBe(upper.toLowerCase());
  });

  it('rejects malformed digests', () => {
    expect(isSha256Hex('abc')).toBe(false);
    expect(isSha256Hex('z'.repeat(64))).toBe(false);
    expect(() => normalizeSha256('abc')).toThrow(/sha-?256/i);
    expect(() => normalizeSha256(undefined)).toThrow(/sha-?256/i);
  });
});
