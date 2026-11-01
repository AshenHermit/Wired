import { HttpException, HttpStatus } from '@nestjs/common';
import { ArtifactBuildRateLimiter } from './artifact-build.rate-limiter';

describe('ArtifactBuildRateLimiter', () => {
  const limitKey = 'WIRED_ARTIFACT_BUILD_RATE_LIMIT';
  const windowKey = 'WIRED_ARTIFACT_BUILD_RATE_WINDOW_MS';
  const savedLimit = process.env[limitKey];
  const savedWindow = process.env[windowKey];

  beforeEach(() => {
    delete process.env[limitKey];
    delete process.env[windowKey];
  });

  afterAll(() => {
    if (savedLimit === undefined) delete process.env[limitKey];
    else process.env[limitKey] = savedLimit;
    if (savedWindow === undefined) delete process.env[windowKey];
    else process.env[windowKey] = savedWindow;
  });

  it('allows the default budget of ten builds per key', () => {
    const limiter = new ArtifactBuildRateLimiter();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(() => limiter.assertAllowed(5, 3, 7, 1_000)).not.toThrow();
    }
  });

  it('rejects the eleventh build of the same key with HTTP 429', () => {
    const limiter = new ArtifactBuildRateLimiter();

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
    const limiter = new ArtifactBuildRateLimiter(2, 60_000);

    limiter.assertAllowed(5, 3, 7, 1_000);
    limiter.assertAllowed(5, 3, 7, 1_000);

    expect(() => limiter.assertAllowed(6, 3, 7, 1_000)).not.toThrow();
    expect(() => limiter.assertAllowed(5, 4, 7, 1_000)).not.toThrow();
    expect(() => limiter.assertAllowed(5, 3, 8, 1_000)).not.toThrow();
  });

  it('reopens the budget after the window expires', () => {
    const limiter = new ArtifactBuildRateLimiter(1, 60_000);

    limiter.assertAllowed(5, 3, 7, 1_000);
    expect(() => limiter.assertAllowed(5, 3, 7, 1_001)).toThrow(HttpException);
    expect(() => limiter.assertAllowed(5, 3, 7, 61_001)).not.toThrow();
  });

  it('reads the limit and window from the environment', () => {
    process.env[limitKey] = '2';
    process.env[windowKey] = '500';
    const limiter = new ArtifactBuildRateLimiter();

    limiter.assertAllowed(5, 3, 7, 1_000);
    limiter.assertAllowed(5, 3, 7, 1_000);
    expect(() => limiter.assertAllowed(5, 3, 7, 1_000)).toThrow(HttpException);
    expect(() => limiter.assertAllowed(5, 3, 7, 1_500)).not.toThrow();
  });

  it('falls back to the defaults for malformed environment values', () => {
    process.env[limitKey] = 'not-a-number';
    process.env[windowKey] = '0';
    const limiter = new ArtifactBuildRateLimiter();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(() => limiter.assertAllowed(5, 3, 7, 1_000)).not.toThrow();
    }
    expect(() => limiter.assertAllowed(5, 3, 7, 1_000)).toThrow(HttpException);
  });
});
