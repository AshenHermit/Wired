import { AppConfigService } from 'src/config/config.service';
import {
  GameRoomTicketRateLimiter,
  InMemoryTicketRateLimitStore,
} from './game-room.rate-limiter';

const configService = (
  ticketRateLimit = 3,
  ticketRateLimitWindowMs = 60_000,
): AppConfigService =>
  ({
    godotRuntime: { ticketRateLimit, ticketRateLimitWindowMs },
  }) as unknown as AppConfigService;

const createLimiter = (
  ticketRateLimit = 3,
  ticketRateLimitWindowMs = 60_000,
): GameRoomTicketRateLimiter =>
  new GameRoomTicketRateLimiter(
    configService(ticketRateLimit, ticketRateLimitWindowMs),
    new InMemoryTicketRateLimitStore(),
  );

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

  it('keeps its windows in memory by default', () => {
    // Two instances of the default (process-local) store do not share state:
    // this is exactly the single-instance limitation the interface documents.
    const first = createLimiter(1, 60_000);
    const second = createLimiter(1, 60_000);

    expect(first.consume(1, 10, 0).allowed).toBe(true);
    expect(second.consume(1, 10, 0).allowed).toBe(true);
  });

  it('can share its windows through an injected store', () => {
    // A shared store is what a multi-instance deploy would inject; the limiter
    // itself does not change.
    const store = new InMemoryTicketRateLimitStore();
    const limit = configService(1, 60_000);
    const first = new GameRoomTicketRateLimiter(limit, store);
    const second = new GameRoomTicketRateLimiter(limit, store);

    expect(first.consume(1, 10, 0).allowed).toBe(true);
    expect(second.consume(1, 10, 0).allowed).toBe(false);
    expect(second.consume(1, 10, 60_001).allowed).toBe(true);
  });
});
