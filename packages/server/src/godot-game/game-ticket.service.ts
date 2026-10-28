import { createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { RoomRuntimeError } from './room-runtime.errors';

export interface MintedGameTicket {
  ticket: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Mints the short-lived single-use ticket consumed by the Godot room server.
 *
 * Format and signature are defined by the Godot project
 * (`_wired/scripts/network/ticket.gd`): `<exp>.<nonce>.<hmac_sha256>` over
 * `<room>:<exp>:<nonce>`, keyed by `WIRED_GAME_TICKET_SECRET`.
 *
 * Nonces are random per request, so a ticket cannot be replayed: the Godot
 * runtime burns the nonce on first successful verification.
 */
@Injectable()
export class GameTicketService {
  constructor(private readonly configService: AppConfigService) {}

  mint(roomId: string, ttlSec?: number): MintedGameTicket {
    const config = this.configService.godotRuntime;
    if (!config.ticketSecret) {
      throw new RoomRuntimeError(
        'ticket_secret_missing',
        'WIRED_GAME_TICKET_SECRET is not configured; the Godot room server cannot verify game tickets',
      );
    }

    const expiresAt =
      Math.floor(Date.now() / 1000) + (ttlSec ?? config.ticketTtlSec);
    const nonce = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', config.ticketSecret)
      .update(`${roomId}:${expiresAt}:${nonce}`)
      .digest('hex');

    return {
      ticket: `${expiresAt}.${nonce}.${signature}`,
      nonce,
      expiresAt,
    };
  }
}
