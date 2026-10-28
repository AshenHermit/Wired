import { AppConfigService } from 'src/config/config.service';
import { resolve, join } from 'node:path';
import { RoomRuntimeError } from './room-runtime.errors';
import { GodotRuntimeConfig, RuntimeSpawnOptions } from './room-runtime.types';

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RUNTIME_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'LANG',
  'LC_ALL',
  'TZ',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
];

export class RoomRuntimeConfiguration {
  constructor(private readonly configService: AppConfigService) {}

  validateRoomId(roomId: string): void {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new RoomRuntimeError(
        'invalid_room',
        `Room id ${JSON.stringify(roomId)} is not a safe runtime identifier`,
        roomId,
      );
    }
  }

  validate(config: GodotRuntimeConfig): void {
    if (!config.executablePath || !config.projectPath) {
      throw new RoomRuntimeError(
        'config',
        'GODOT_RUNTIME_PATH and GODOT_RUNTIME_PROJECT_PATH must be configured',
      );
    }
    if (
      !Number.isInteger(config.portStart) ||
      !Number.isInteger(config.portEnd) ||
      config.portStart < 1 ||
      config.portEnd > 65_535 ||
      config.portStart > config.portEnd
    ) {
      throw new RoomRuntimeError(
        'config',
        `Invalid Godot room port range ${config.portStart}-${config.portEnd}`,
      );
    }
    if (!config.ticketSecret) {
      throw new RoomRuntimeError(
        'ticket_secret_missing',
        'WIRED_GAME_TICKET_SECRET is not configured; the Godot room server cannot verify game tickets',
      );
    }
    if (
      !Number.isFinite(config.shutdownGraceMs) ||
      config.shutdownGraceMs < 0 ||
      !Number.isFinite(config.startTimeoutMs) ||
      config.startTimeoutMs <= 0 ||
      !Number.isFinite(config.ticketTtlSec) ||
      config.ticketTtlSec <= 0 ||
      !Number.isFinite(config.idleTimeoutMs) ||
      config.idleTimeoutMs < 0
    ) {
      throw new RoomRuntimeError(
        'config',
        'Invalid Godot room timeouts: start/ticket TTL must be > 0, grace and idle must be >= 0',
      );
    }
    if (this.configService.isProduction && !config.publicWsBaseUrl) {
      throw new RoomRuntimeError(
        'config',
        'GODOT_ROOM_PUBLIC_WS_BASE is required in production; clients must not receive internal ports',
      );
    }
  }

  resolvePaths(config: GodotRuntimeConfig): {
    projectPath: string;
    stateDir: string;
  } {
    return {
      projectPath: resolve(config.projectPath),
      stateDir: resolve(config.stateDir),
    };
  }

  createSpawnOptions(
    config: GodotRuntimeConfig,
    roomId: string,
    port: number,
  ): RuntimeSpawnOptions {
    const { projectPath, stateDir } = this.resolvePaths(config);
    return {
      executablePath: config.executablePath,
      args: [
        '--headless',
        '--path',
        projectPath,
        '--server',
        '--port',
        String(port),
        '--room',
        roomId,
        '--bind',
        config.bindAddress,
        // Godot changes its cwd to the project directory when --path is set.
        '--state-dir',
        join(stateDir, this.safeName(roomId)),
      ],
      cwd: projectPath,
      env: this.buildRuntimeEnv(config.ticketSecret),
    };
  }

  buildEndpoint(
    config: GodotRuntimeConfig,
    roomId: string,
    port: number,
  ): string {
    const template = config.publicWsBaseUrl;
    if (template) {
      return template
        .split('{room}')
        .join(encodeURIComponent(roomId))
        .split('{port}')
        .join(String(port));
    }
    const host =
      !config.bindAddress || config.bindAddress === '0.0.0.0'
        ? '127.0.0.1'
        : config.bindAddress;
    return `ws://${host}:${port}`;
  }

  private buildRuntimeEnv(ticketSecret: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of RUNTIME_ENV_ALLOWLIST) {
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    env.WIRED_GAME_TICKET_SECRET = ticketSecret;
    return env;
  }

  private safeName(roomId: string): string {
    return roomId.replace(/[^a-zA-Z0-9._-]/g, '_');
  }
}
