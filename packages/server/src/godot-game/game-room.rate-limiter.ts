import { Injectable } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';

export interface TicketRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

const MAX_TRACKED_KEYS = 5_000;

/**
 * Sliding-window limit for join requests, keyed by user and room. It stops a
 * signed-in client from starting or reusing runtimes by hammering the join
 * endpoint; it is in-memory because a room runtime lives in one backend
 * process anyway.
 */
@Injectable()
export class GameRoomTicketRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly configService: AppConfigService) {}

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

    if (this.hits.size > MAX_TRACKED_KEYS) {
      this.prune(now, ticketRateLimitWindowMs);
    }

    const key = `${userId}:${roomId}`;
    const cutoff = now - ticketRateLimitWindowMs;
    const timestamps = (this.hits.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );

    if (timestamps.length >= ticketRateLimit) {
      this.hits.set(key, timestamps);
      const retryAfterMs = timestamps[0] + ticketRateLimitWindowMs - now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private prune(now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((timestamp) => timestamp <= cutoff)) {
        this.hits.delete(key);
      }
    }
  }
}
