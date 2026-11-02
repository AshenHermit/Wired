import { AppConfigService } from 'src/config/config.service';
import { resolve, join } from 'node:path';
import { RoomRuntimeError } from './room-runtime.errors';
import { safeRoomName } from './room-runtime.names';
import { createRuntimeServiceToken } from './runtime-service-token';
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
    if (!config.publicWsBaseUrl) {
      // Validate the derived endpoint before a runtime is spawned; otherwise a
      // malformed GODOT_ROOM_API_URL fails only after the child is running.
      this.deriveEndpoint(config.apiUrl, '0');
    }
    if (config.publicWsBaseUrl) {
      if (!/^wss?:\/\//.test(config.publicWsBaseUrl)) {
        throw new RoomRuntimeError(
          'config',
          'GODOT_ROOM_PUBLIC_WS_BASE must start with ws:// or wss://',
        );
      }
      if (
        !config.publicWsBaseUrl.includes('{room}') &&
        !config.publicWsBaseUrl.includes('{port}')
      ) {
        throw new RoomRuntimeError(
          'config',
          'GODOT_ROOM_PUBLIC_WS_BASE must contain the {room} placeholder',
        );
      }
      if (this.configService.isProduction) {
        if (!config.publicWsBaseUrl.startsWith('wss://')) {
          throw new RoomRuntimeError(
            'config',
            'GODOT_ROOM_PUBLIC_WS_BASE must use wss:// in production',
          );
        }
        if (!config.publicWsBaseUrl.includes('{room}')) {
          throw new RoomRuntimeError(
            'config',
            'GODOT_ROOM_PUBLIC_WS_BASE must contain {room} in production; a port-only base leaks internal ports',
          );
        }
      }
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
    paths: { projectPath: string; stateDir: string } = this.resolvePaths(
      config,
    ),
  ): RuntimeSpawnOptions {
    const { projectPath, stateDir } = paths;
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
        join(stateDir, safeRoomName(roomId)),
        // Package manifests and files are served by the Wired API, not by the
        // game socket. The URL is configuration, not derived from the ambient
        // PORT, so a proxy or a different backend port cannot break lookups.
        '--api-url',
        config.apiUrl,
      ],
      cwd: projectPath,
      env: this.buildRuntimeEnv(config.ticketSecret, roomId),
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
    return this.deriveEndpoint(config.apiUrl, roomId);
  }

  private deriveEndpoint(apiUrl: string, roomId: string): string {
    let url: URL;
    try {
      url = new URL(apiUrl);
    } catch {
      throw new RoomRuntimeError(
        'config',
        `Invalid GODOT_ROOM_API_URL ${apiUrl}`,
      );
    }
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    } else {
      throw new RoomRuntimeError(
        'config',
        `GODOT_ROOM_API_URL must be http(s), got ${url.protocol}`,
      );
    }
    url.search = '';
    url.hash = '';
    const base = url.pathname.replace(/\/+$/, '');
    url.pathname = `${base}/rooms/${encodeURIComponent(roomId)}/game/ws`;
    return url.toString();
  }

  private buildRuntimeEnv(
    ticketSecret: string,
    roomId: string,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of RUNTIME_ENV_ALLOWLIST) {
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    env.WIRED_GAME_TICKET_SECRET = ticketSecret;
    // Authenticates the runtime on the room-scoped package routes. It is
    // derived from the ticket secret and never leaves the server host.
    env.WIRED_RUNTIME_API_TOKEN = createRuntimeServiceToken(
      ticketSecret,
      roomId,
    );
    return env;
  }
}
