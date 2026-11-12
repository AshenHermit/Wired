import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssetBakeCache } from './asset-bake-cache';

describe('AssetBakeCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asset-bake-cache-evict-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('вытесняет самые старые файлы по бюджету', async () => {
    const cache = new AssetBakeCache(dir, 4);
    await cache.put('a.scn', Buffer.from('aaa'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cache.put('b.scn', Buffer.from('bbb'));

    await cache.prune();

    expect(cache.get('a.scn')).toBeNull();
    expect(cache.get('b.scn')?.equals(Buffer.from('bbb'))).toBe(true);
  });

  it('различает пресеты с разными материалами', () => {
    const cache = new AssetBakeCache(dir, 1024);
    const source = Buffer.from('glb');
    const preset = '[remap]\n\nimporter="scene"\n';

    const first = cache.keyFor(source, preset, [Buffer.from('red material')]);
    const second = cache.keyFor(source, preset, [Buffer.from('blue material')]);

    expect(first).not.toBe(second);
  });

  it('пишет файл атомарно, не оставляя временных копий', async () => {
    const cache = new AssetBakeCache(dir, 1024);

    await cache.put('a.scn', Buffer.from('aaa'));

    expect(readdirSync(dir)).toEqual(['a.scn']);
  });
});
