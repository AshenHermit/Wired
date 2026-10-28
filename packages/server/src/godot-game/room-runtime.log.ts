import { Logger } from '@nestjs/common';
import { createWriteStream, mkdirSync, WriteStream } from 'node:fs';
import { join } from 'node:path';

export class RoomRuntimeLog {
  private readonly lines: string[] = [];
  private stream: WriteStream | null = null;

  constructor(
    private readonly roomId: string,
    private readonly key: string,
    private readonly port: number,
    private readonly bufferLimit: number,
    private readonly logger: Logger,
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

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
