import { HttpException, HttpStatus } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { ArtifactBuildRateLimiter } from './artifact-build.rate-limiter';

/** Builds a limiter pinned to a budget, without touching the environment. */
function limiterWith(limit: number, windowMs = 60_000) {
  return new ArtifactBuildRateLimiter({
    packages: {
      artifactBuildRateLimit: limit,
      artifactBuildRateWindowMs: windowMs,
    },
  } as unknown as AppConfigService);
}

describe('ArtifactBuildRateLimiter', () => {
  it('allows the configured budget per key', () => {
    const limiter = limiterWith(10);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(() => limiter.assertAllowed(5, 3, 7, 1_000)).not.toThrow();
    }
  });

  it('rejects the eleventh build of the same key with HTTP 429', () => {
    const limiter = limiterWith(10);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.assertAllowed(5, 3, 7, 1_000);
    }

    let caught: unknown;
    try {
      limiter.assertAllowed(5, 3, 7, 1_000);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('keeps the budget of independent keys separate', () => {
    const limiter = limiterWith(2);

    limiter.assertAllowed(5, 3, 7, 1_000);
    limiter.assertAllowed(5, 3, 7, 1_000);

    expect(() => limiter.assertAllowed(6, 3, 7, 1_000)).not.toThrow();
    expect(() => limiter.assertAllowed(5, 4, 7, 1_000)).not.toThrow();
    expect(() => limiter.assertAllowed(5, 3, 8, 1_000)).not.toThrow();
  });

  it('reopens the budget after the window expires', () => {
    const limiter = limiterWith(1, 60_000);

    limiter.assertAllowed(5, 3, 7, 1_000);
    expect(() => limiter.assertAllowed(5, 3, 7, 1_001)).toThrow(HttpException);
    expect(() => limiter.assertAllowed(5, 3, 7, 61_001)).not.toThrow();
  });

  it('drops expired windows instead of growing without bound', () => {
    const limiter = limiterWith(1, 500);

    for (let roomId = 0; roomId < 30; roomId += 1) {
      limiter.assertAllowed(1, 1, roomId, 1_000);
    }

    expect(() => limiter.assertAllowed(2, 1, 1, 2_000)).not.toThrow();
  });
});
