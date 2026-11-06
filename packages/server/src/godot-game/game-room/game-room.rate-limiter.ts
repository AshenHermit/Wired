import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';

export interface TicketRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Storage for the per-key hit windows of the join limiter.
 *
 * The limiter is **process-local by default**: `InMemoryTicketRateLimitStore`
 * keeps the windows in a `Map`, so with more than one backend instance every
 * instance enforces the configured limit on its own and a client can spread
 * attempts across instances (N × limit). That is acceptable while a room
 * runtime is pinned to one backend process, but a horizontally scaled deploy
 * must inject a shared store (Redis, Postgres) through
 * `TICKET_RATE_LIMIT_STORE`.
 */
export interface TicketRateLimitStore {
  get(key: string): number[] | undefined;
  set(key: string, timestamps: number[]): void;
  delete(key: string): void;
  entries(): IterableIterator<[string, number[]]>;
  readonly size: number;
}

/** Nest injection token for a future shared implementation. */
export const TICKET_RATE_LIMIT_STORE = Symbol('TICKET_RATE_LIMIT_STORE');

/** Single-instance default: windows live in this process's memory. */
export class InMemoryTicketRateLimitStore implements TicketRateLimitStore {
  private readonly hits = new Map<string, number[]>();

  get(key: string): number[] | undefined {
    return this.hits.get(key);
  }

  set(key: string, timestamps: number[]): void {
    this.hits.set(key, timestamps);
  }

  delete(key: string): void {
    this.hits.delete(key);
  }

  entries(): IterableIterator<[string, number[]]> {
    return this.hits.entries();
  }

  get size(): number {
    return this.hits.size;
  }
}

const MAX_TRACKED_KEYS = 5_000;

/**
 * Sliding-window limit for join requests, keyed by user and room. It stops a
 * signed-in client from starting or reusing runtimes by hammering the join
 * endpoint.
 *
 * The decision logic is independent of the storage: `GodotGameModule` binds
 * `TICKET_RATE_LIMIT_STORE` to the in-memory store, and a horizontally scaled
 * deploy overrides that binding with a shared backend (Redis, Postgres) without
 * touching this class or its callers.
 */
@Injectable()
export class GameRoomTicketRateLimiter {
  constructor(
    private readonly configService: AppConfigService,
    @Inject(TICKET_RATE_LIMIT_STORE)
    private readonly store: TicketRateLimitStore,
  ) {}

  consume(
    userId: number,
    roomId: number,
    now = Date.now(),
  ): TicketRateLimitDecision {
    const { ticketRateLimit, ticketRateLimitWindowMs } =
      this.configService.godotRuntime;
    if (ticketRateLimit <= 0 || ticketRateLimitWindowMs <= 0) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (this.store.size > MAX_TRACKED_KEYS) {
      this.prune(now, ticketRateLimitWindowMs);
    }

    const key = `${userId}:${roomId}`;
    const cutoff = now - ticketRateLimitWindowMs;
    const timestamps = (this.store.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );

    if (timestamps.length >= ticketRateLimit) {
      this.store.set(key, timestamps);
      const retryAfterMs = timestamps[0] + ticketRateLimitWindowMs - now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
      };
    }

    timestamps.push(now);
    this.store.set(key, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private prune(now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    for (const [key, timestamps] of this.store.entries()) {
      if (timestamps.every((timestamp) => timestamp <= cutoff)) {
        this.store.delete(key);
      }
    }
  }
}
