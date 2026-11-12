import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

export type GitRunOptions = {
  cwd: string;
  input?: Buffer | string;
  timeoutMs?: number;
  maxBuffer?: number;
};

export type GitStreamOptions = Omit<GitRunOptions, 'maxBuffer'>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;
const STDERR_LIMIT = 4 * 1024;

export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
    message?: string,
  ) {
    super(message ?? `git ${args.join(' ')} failed with exit code ${code}`);
    this.name = 'GitCommandError';
  }
}

function emptyGlobalConfig(): string {
  const file = path.join(tmpdir(), 'wired-git-global-config');
  if (!existsSync(file)) {
    writeFileSync(file, '');
  }
  return file;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function appendLimited(chunks: Buffer[], chunk: Buffer, limit: number): number {
  const current = chunks.reduce((sum, item) => sum + item.length, 0);
  if (current >= limit) {
    return current;
  }
  chunks.push(chunk.subarray(0, limit - current));
  return current + chunk.length;
}

export class GitCommand {
  run(args: string[], options: GitRunOptions): Promise<Buffer> {
    const {
      cwd,
      input,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxBuffer = DEFAULT_MAX_BUFFER,
    } = options;

    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: gitEnv(),
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let overflowed = false;
      let settled = false;

      const fail = (error: GitCommandError) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxBuffer) {
          overflowed = true;
          child.kill('SIGKILL');
          return;
        }
        stdout.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes = appendLimited(stderr, chunk, STDERR_LIMIT);
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        fail(
          new GitCommandError(
            args,
            null,
            stderrBytes > 0 ? Buffer.concat(stderr).toString() : '',
            `failed to start git: ${error.message}`,
          ),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const stderrText = Buffer.concat(stderr).toString();

        if (timedOut) {
          fail(
            new GitCommandError(
              args,
              code,
              stderrText,
              `git ${args.join(' ')} timed out after ${timeoutMs}ms`,
            ),
          );
          return;
        }

        if (overflowed) {
          fail(
            new GitCommandError(
              args,
              code,
              stderrText,
              `git ${args.join(' ')} produced more than ${maxBuffer} bytes`,
            ),
          );
          return;
        }

        if (code !== 0) {
          fail(new GitCommandError(args, code, stderrText));
          return;
        }

        if (settled) {
          return;
        }
        settled = true;
        resolve(Buffer.concat(stdout));
      });

      child.stdin.end(input ?? undefined);
    });
  }

  stream(args: string[], options: GitStreamOptions): Readable {
    const { cwd, input, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const child = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: gitEnv(),
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', () => clearTimeout(timer));
    child.on('error', (error) => {
      clearTimeout(timer);
      child.stdout.destroy(error);
    });

    child.stdin.end(input ?? undefined);
    return child.stdout;
  }
}
