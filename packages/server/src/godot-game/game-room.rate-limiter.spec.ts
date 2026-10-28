import { AppConfigService } from 'src/config/config.service';
import { GameRoomTicketRateLimiter } from './game-room.rate-limiter';

const createLimiter = (
  ticketRateLimit = 3,
  ticketRateLimitWindowMs = 60_000,
): GameRoomTicketRateLimiter => {
  const configService = {
    godotRuntime: { ticketRateLimit, ticketRateLimitWindowMs },
  } as unknown as AppConfigService;
  return new GameRoomTicketRateLimiter(configService);
};

describe('GameRoomTicketRateLimiter', () => {
  it('allows the configured number of tickets and then reports when to retry', () => {
    const limiter = createLimiter(3, 60_000);
    const now = 1_000_000;

    expect(limiter.consume(1, 10, now).allowed).toBe(true);
    expect(limiter.consume(1, 10, now + 1_000).allowed).toBe(true);
    expect(limiter.consume(1, 10, now + 2_000).allowed).toBe(true);

    const blocked = limiter.consume(1, 10, now + 3_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(57);
  });

  it('slides the window instead of locking the user out forever', () => {
    const limiter = createLimiter(2, 10_000);
    const now = 500_000;

    expect(limiter.consume(1, 10, now).allowed).toBe(true);
    expect(limiter.consume(1, 10, now + 1_000).allowed).toBe(true);
    expect(limiter.consume(1, 10, now + 2_000).allowed).toBe(false);
    expect(limiter.consume(1, 10, now + 10_001).allowed).toBe(true);
  });

  it('counts each user and room separately', () => {
    const limiter = createLimiter(1, 60_000);

    expect(limiter.consume(1, 10, 0).allowed).toBe(true);
    expect(limiter.consume(1, 10, 0).allowed).toBe(false);
    expect(limiter.consume(2, 10, 0).allowed).toBe(true);
    expect(limiter.consume(1, 11, 0).allowed).toBe(true);
  });

  it('can be disabled with a non-positive limit', () => {
    const limiter = createLimiter(0, 60_000);

    for (let i = 0; i < 50; i += 1) {
      expect(limiter.consume(1, 10, 0).allowed).toBe(true);
    }
  });
});
