import { createHmac } from 'node:crypto';
import { AppConfigService } from 'src/config/config.service';
import { GameTicketService } from './game-ticket.service';
import { GodotRuntimeConfig } from '../runtime/room-runtime.types';

const baseConfig: GodotRuntimeConfig = {
  executablePath: 'godot.exe',
  projectPath: 'project',
  portStart: 19100,
  portEnd: 19199,
  bindAddress: '127.0.0.1',
  idleTimeoutMs: 1_000,
  shutdownGraceMs: 1_000,
  startTimeoutMs: 1_000,
  ticketTtlSec: 60,
  ticketSecret: 'ticket-secret',
  ticketRateLimit: 20,
  ticketRateLimitWindowMs: 60_000,
  stateSaveIntervalMs: 30_000,
  stateDir: 'state',
  apiUrl: 'http://127.0.0.1:3000',
  exportDir: 'game_export/web',
  publicWsBaseUrl: '',
  wsMaxClientsPerRoom: 32,
  wsMaxTotal: 512,
  logBufferLines: 100,
};

const createService = (
  overrides: Partial<GodotRuntimeConfig> = {},
): GameTicketService => {
  const configService = {
    godotRuntime: { ...baseConfig, ...overrides },
  } as unknown as AppConfigService;
  return new GameTicketService(configService);
};

describe('GameTicketService', () => {
  it('mints v2 tickets signed with the authenticated account ID', () => {
    const service = createService();
    const now = Math.floor(Date.now() / 1000);
    const minted = service.mint('room-1', 42);

    const [version, exp, accountId, nonce, mac] = minted.ticket.split('.');
    expect(version).toBe('v2');
    expect(Number(exp)).toBeGreaterThanOrEqual(now + 50);
    expect(accountId).toBe('42');
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(mac).toBe(
      createHmac('sha256', 'ticket-secret')
        .update(`v2:room-1:${accountId}:${exp}:${nonce}`)
        .digest('hex'),
    );
  });

  it('binds the ticket to the room and account and never reuses a nonce', () => {
    const service = createService();
    const first = service.mint('room-1', 42);
    const second = service.mint('room-2', 42);
    const third = service.mint('room-1', 43);

    expect(first.ticket).not.toBe(second.ticket);
    expect(first.ticket).not.toBe(third.ticket);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ticket).toContain(first.nonce);
  });

  it.each([0, -1])('rejects non-positive account ID %s', (accountId) => {
    const service = createService();

    expect(() => service.mint('room-1', accountId)).toThrow(
      /account ID must be positive/,
    );
  });

  it('fails explicitly when the shared secret is missing', () => {
    const service = createService({ ticketSecret: '' });

    expect(() => service.mint('room-1', 1)).toThrow(/WIRED_GAME_TICKET_SECRET/);
  });
});
