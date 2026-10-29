import { Logger } from '@nestjs/common';
import {
  createWriteStream,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  WriteStream,
} from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

export class RoomRuntimeLog {
  private readonly lines: string[] = [];
  private stream: WriteStream | null = null;

  constructor(
    private readonly roomId: string,
    private readonly key: string,
    private readonly port: number,
    private readonly bufferLimit: number,
    private readonly logger: Logger,
    private readonly maxFileBytes = DEFAULT_MAX_LOG_BYTES,
  ) {}

  getLines(): string[] {
    return [...this.lines];
  }

  open(stateDir: string): void {
    try {
      mkdirSync(stateDir, { recursive: true });
      const path = join(
        stateDir,
        `${this.safeName(this.roomId)}-${this.port}.log`,
      );
      this.rotateIfNeeded(path);
      this.stream = createWriteStream(path, { flags: 'a' });
      this.stream.on('error', (error) => {
        this.logger.warn(
          `Cannot write runtime log for room ${this.roomId}: ${error.message}`,
        );
      });
      this.stream.write(
        `[wired] session key=${this.key} started_at=${new Date().toISOString()}\n`,
      );
    } catch (error) {
      this.logger.warn(
        `Cannot open runtime log for room ${this.roomId}: ${this.errorMessage(error)}`,
      );
    }
  }

  append(line: string): void {
    this.lines.push(line);
    if (this.bufferLimit > 0 && this.lines.length > this.bufferLimit) {
      this.lines.splice(0, this.lines.length - this.bufferLimit);
    }
    this.stream?.write(`${line}\n`);
  }

  close(): void {
    const stream = this.stream;
    if (!stream) {
      return;
    }
    this.stream = null;
    stream.end();
  }

  private safeName(roomId: string): string {
    return roomId.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  /**
   * One runtime log per room and port is appended forever, so a long-lived
   * deployment would grow without bound. Keep the current file under the size
   * budget and one previous generation next to it.
   */
  private rotateIfNeeded(path: string): void {
    try {
      if (statSync(path).size < this.maxFileBytes) {
        return;
      }
      const previous = `${path}.1`;
      rmSync(previous, { force: true });
      renameSync(path, previous);
    } catch {
      // Missing file or a racing rotation is fine: the log is diagnostics only.
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
