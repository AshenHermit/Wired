import { AppConfigService } from 'src/config/config.service';
import { GodotRuntimeConfig } from './room-runtime.types';
import { RoomRuntimeConfiguration } from './room-runtime.configuration';
import { verifyRuntimeServiceToken } from './runtime-service-token';

const config: GodotRuntimeConfig = {
  executablePath: 'C:/godot/godot.exe',
  projectPath: './godot_project',
  portStart: 19100,
  portEnd: 19199,
  bindAddress: '127.0.0.1',
  idleTimeoutMs: 60_000,
  shutdownGraceMs: 5_000,
  startTimeoutMs: 30_000,
  ticketTtlSec: 60,
  ticketSecret: 'secret',
  ticketRateLimit: 10,
  ticketRateLimitWindowMs: 60_000,
  stateDir: './storage/rooms',
  publicWsBaseUrl: '',
  wsMaxClientsPerRoom: 32,
  wsMaxTotal: 512,
  logBufferLines: 200,
  exportDir: './game_export/web',
  apiUrl: 'http://127.0.0.1:4123',
};

describe('RoomRuntimeConfiguration', () => {
  const configuration = new RoomRuntimeConfiguration(
    {} as unknown as AppConfigService,
  );

  it('tells the runtime where the backend API lives', () => {
    const options = configuration.createSpawnOptions(config, 'room-1', 19101);

    const index = options.args.indexOf('--api-url');
    expect(index).toBeGreaterThan(-1);
    expect(options.args[index + 1]).toBe('http://127.0.0.1:4123');
  });

  it('does not read PORT from the environment', () => {
    const originalPort = process.env.PORT;
    process.env.PORT = '5999';
    try {
      const options = configuration.createSpawnOptions(config, 'room-1', 19101);
      expect(options.args[options.args.indexOf('--api-url') + 1]).toBe(
        'http://127.0.0.1:4123',
      );
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });

  it('never leaks the ticket secret into the command line', () => {
    const options = configuration.createSpawnOptions(config, 'room-1', 19101);

    expect(options.args.join(' ')).not.toContain('secret');
    expect(options.env?.WIRED_GAME_TICKET_SECRET).toBe('secret');
  });

  it('injects a room-scoped runtime API token', () => {
    const options = configuration.createSpawnOptions(config, 'room-1', 19101);
    const token = options.env?.WIRED_RUNTIME_API_TOKEN;

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRuntimeServiceToken('secret', 'room-1', `Bearer ${token}`)).toBe(
      true,
    );
    expect(verifyRuntimeServiceToken('secret', 'room-2', `Bearer ${token}`)).toBe(
      false,
    );
  });

  const production = new RoomRuntimeConfiguration({
    isProduction: true,
  } as unknown as AppConfigService);

  it('derives the API WebSocket route from apiUrl outside production', () => {
    expect(configuration.buildEndpoint(config, '42', 19100)).toBe(
      'ws://127.0.0.1:4123/rooms/42/game/ws',
    );
  });

  it('keeps a base path and upgrades https to wss', () => {
    expect(
      configuration.buildEndpoint(
        { ...config, apiUrl: 'https://api.example.com/wired/' },
        '42',
        19100,
      ),
    ).toBe('wss://api.example.com/wired/rooms/42/game/ws');
  });

  it('interpolates room and port in an explicit public base', () => {
    expect(
      configuration.buildEndpoint(
        {
          ...config,
          publicWsBaseUrl: 'wss://games.example/godot/{room}?p={port}',
        },
        '42',
        19100,
      ),
    ).toBe('wss://games.example/godot/42?p=19100');
  });

  it('rejects a public base without placeholders', () => {
    expect(() =>
      configuration.validate({
        ...config,
        publicWsBaseUrl: 'wss://games.example/godot',
      }),
    ).toThrow(/placeholder|\{room\}/i);
  });

  it('rejects a port-only public base in production', () => {
    expect(() =>
      production.validate({
        ...config,
        publicWsBaseUrl: 'wss://games.example/godot?p={port}',
      }),
    ).toThrow(/room/i);
  });

  it('requires a wss public base in production', () => {
    expect(() =>
      production.validate({
        ...config,
        publicWsBaseUrl: 'ws://games.example/rooms/{room}/game/ws',
      }),
    ).toThrow(/wss/i);
  });

  it('still requires a public base in production', () => {
    expect(() =>
      production.validate({ ...config, publicWsBaseUrl: '' }),
    ).toThrow(/GODOT_ROOM_PUBLIC_WS_BASE/);
  });
});
