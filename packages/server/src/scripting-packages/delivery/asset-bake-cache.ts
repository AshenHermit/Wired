import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
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

  keyFor(source: Buffer, preset: string | null): string {
    const sourceHash = hash(source);
    const presetHash = hash(Buffer.from(`${preset ?? ''}\u0000${BAKE_TOOL_VERSION}`, 'utf8'));
    return `${sourceHash}-${presetHash}.scn`;
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
    await writeFile(join(this.dir, fileName), bytes);
  }

  /** Drops the oldest entries until the directory fits the byte budget. */
  async prune(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
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
