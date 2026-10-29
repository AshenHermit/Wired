import { AppConfigService } from 'src/config/config.service';
import { GodotRuntimeConfig } from './room-runtime.types';
import { RoomRuntimeConfiguration } from './room-runtime.configuration';

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
});
