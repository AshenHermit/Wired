import { createHash } from 'crypto';
import { createReadStream } from 'fs';

const SHA256_HEX = /^[a-f0-9]{64}$/i;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

export function normalizeSha256(value: unknown): string {
  if (!isSha256Hex(value)) {
    throw new Error('sha256 must be a 64 character hex digest');
  }
  return value.toLowerCase();
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Streaming digest, so large package files are not loaded into memory. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
