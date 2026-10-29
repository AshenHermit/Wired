import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { RoomRuntimeLog } from './room-runtime.log';

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('RoomRuntimeLog', () => {
  let stateDir: string;
  const logger = { warn: jest.fn() } as unknown as Logger;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'wired-log-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('rotates a log file that exceeded its size budget', async () => {
    const path = join(stateDir, 'room-1-19100.log');
    writeFileSync(path, 'x'.repeat(200));

    const log = new RoomRuntimeLog('room-1', 'key', 19100, 10, logger, 100);
    log.open(stateDir);
    log.close();

    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(200);
    await waitFor(() => existsSync(path));
    expect(statSync(path).size).toBeLessThan(200);
  });

  it('keeps appending while the file is below the budget', async () => {
    const path = join(stateDir, 'room-1-19100.log');
    writeFileSync(path, 'old\n');

    const log = new RoomRuntimeLog('room-1', 'key', 19100, 10, logger, 100);
    log.open(stateDir);
    log.close();

    await waitFor(() => existsSync(path));
    expect(readFileSync(path, 'utf8')).toContain('old');
    expect(existsSync(`${path}.1`)).toBe(false);
  });
});
