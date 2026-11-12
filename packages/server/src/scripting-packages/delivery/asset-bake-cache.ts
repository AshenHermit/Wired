import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BAKE_TOOL_VERSION } from './asset-bake.constants';

/**
 * Disk cache of baked scenes. The key covers the source bytes and the preset
 * (plus the tool version), so a room, revision or artifact key never changes
 * what a baked scene contains.
 */
export class AssetBakeCache {
  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  keyFor(source: Buffer, preset: string | null, assetBytes: Buffer[] = []): string {
    // The preset points at material files whose bytes end up inside the baked
    // scene, so the key has to cover them too.
    const digest = createHash('sha256');
    digest.update(preset ?? '');
    digest.update('\u0000');
    digest.update(String(BAKE_TOOL_VERSION));
    for (const bytes of assetBytes) {
      digest.update('\u0000');
      digest.update(String(bytes.byteLength));
      digest.update(bytes);
    }
    return `${hash(source)}-${digest.digest('hex')}.scn`;
  }

  get(fileName: string): Buffer | null {
    try {
      return readFileSync(join(this.dir, fileName));
    } catch {
      return null;
    }
  }

  async put(fileName: string, bytes: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // A crash mid-write must never leave a truncated scene that the manifest
    // hashes as a valid file.
    const partial = join(this.dir, `${fileName}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await writeFile(partial, bytes);
    await rename(partial, join(this.dir, fileName));
  }

  /** Drops the oldest entries until the directory fits the byte budget. */
  async prune(): Promise<void> {
    let names: string[];
    try {
      // Only finished scenes belong to the budget; temp files mid-write do not.
      names = (await readdir(this.dir)).filter((name) => name.endsWith('.scn'));
    } catch {
      return;
    }
    const entries: Array<{ name: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      try {
        const info = await stat(join(this.dir, name));
        entries.push({ name, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // A concurrent prune already removed it.
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of entries) {
      if (total <= this.maxBytes) {
        return;
      }
      try {
        await unlink(join(this.dir, entry.name));
        total -= entry.size;
      } catch {
        // Ignore: the entry is gone either way.
      }
    }
  }
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
