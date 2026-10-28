import { createHmac } from 'node:crypto';
import { AppConfigService } from 'src/config/config.service';
import { GameTicketService } from './game-ticket.service';
import { GodotRuntimeConfig } from './room-runtime.types';

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
  stateDir: 'state',
  publicWsBaseUrl: '',
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
  it('mints tickets in the format verified by the Godot runtime', () => {
    const service = createService();
    const now = Math.floor(Date.now() / 1000);
    const minted = service.mint('room-1');

    const [exp, nonce, mac] = minted.ticket.split('.');
    expect(Number(exp)).toBeGreaterThanOrEqual(now + 50);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(mac).toBe(
      createHmac('sha256', 'ticket-secret')
        .update(`room-1:${exp}:${nonce}`)
        .digest('hex'),
    );
  });

  it('binds the ticket to the room and never reuses a nonce', () => {
    const service = createService();
    const first = service.mint('room-1');
    const second = service.mint('room-2');

    expect(first.ticket).not.toBe(second.ticket);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ticket).toContain(first.nonce);
  });

  it('fails explicitly when the shared secret is missing', () => {
    const service = createService({ ticketSecret: '' });

    expect(() => service.mint('room-1')).toThrow(/WIRED_GAME_TICKET_SECRET/);
  });
});
