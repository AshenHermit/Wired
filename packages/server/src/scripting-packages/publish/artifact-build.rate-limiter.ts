import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';

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
  /** key -> { count, resetAt } for the current window. */
  private readonly windows = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(private readonly config: AppConfigService) {}

  /** Builds allowed per `(package, revision, room)` per window. */
  private get limit(): number {
    return this.config.packages.artifactBuildRateLimit;
  }

  private get windowMs(): number {
    return this.config.packages.artifactBuildRateWindowMs;
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
