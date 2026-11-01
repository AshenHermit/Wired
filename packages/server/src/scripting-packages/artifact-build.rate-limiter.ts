import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_MS = 60_000;

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Per-process, in-memory guard against artifact-build amplification.
 *
 * Every `runtime-manifest` miss builds a full artifact and writes it to disk,
 * so the same `(packageId, revision, roomId)` must not be able to trigger more
 * than a handful of builds per window. The key includes all three ids on
 * purpose: two different rooms may legitimately request the same revision.
 *
 * Like the other limiters in this codebase this is valid for a single instance
 * only; a multi-instance deployment needs a shared store.
 */
@Injectable()
export class ArtifactBuildRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  /** key -> { count, resetAt } for the current window. */
  private readonly windows = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(limit?: number, windowMs?: number) {
    this.limit =
      limit ??
      positiveInt(process.env.WIRED_ARTIFACT_BUILD_RATE_LIMIT, DEFAULT_LIMIT);
    this.windowMs =
      windowMs ??
      positiveInt(
        process.env.WIRED_ARTIFACT_BUILD_RATE_WINDOW_MS,
        DEFAULT_WINDOW_MS,
      );
  }

  /**
   * Consumes one build slot for the artifact, or throws 429 when the window is
   * exhausted. `now` is injectable so the window behaviour is testable.
   */
  assertAllowed(
    packageId: number,
    revision: number,
    roomId: number,
    now: number = Date.now(),
  ): void {
    const key = `${packageId}:${revision}:${roomId}`;
    const current = this.windows.get(key);

    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return;
    }

    if (current.count >= this.limit) {
      throw new HttpException(
        'artifact_build_rate_limited',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    current.count += 1;
  }

  /** Drops expired windows so the map cannot grow without bound. */
  private prune(now: number): void {
    if (this.windows.size <= this.limit * 10) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
