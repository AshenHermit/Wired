import { join, resolve } from 'node:path';
import { AppConfig } from './config.interface';

const intFromEnv = (name: string, fallback: number): number => {
  const value = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
};

// Filesystem paths are resolved once, when the config is built, so services
// and controllers never have to guess the caller's cwd. Tests and Docker can
// still override every path through the environment.
const storageDir = () => resolve(process.env.STORAGE_DIR ?? './storage');

const config: () => AppConfig = () => ({
  nodeEnv: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  db: {
    host: process.env.DB_HOST ?? 'db',
    port: parseInt(process.env.DB_PORT ?? '5432'),
    username: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'postgres',
    entities: [process.env.DB_ENTITIES ?? 'dist/**/*.entity.{ts,js}'],
    sync: process.env.DB_SYNC === '1',
  },
  site: {
    commonDomain: process.env.COMMON_DOMAIN ?? 'localhost',
    host: process.env.SITE_HOST ?? 'http://localhost:3001',
    authSecret: process.env.AUTH_SECRET ?? 'secret',
    authCookieName: process.env.AUTH_COOKIE_NAME ?? 'access_token',
  },
  storage: {
    dir: storageDir(),
    packagesFilesDir: join(
      storageDir(),
      process.env.PACKAGES_FILES_DIR ?? 'packages_files',
    ),
  },
  godot: {
    editorPath: resolve(process.env.GODOT_EDITOR_PATH ?? './godot_editor'),
    projectPath: resolve(process.env.GODOT_PROJECT_PATH ?? './godot_project'),
  },
  godotRuntime: {
    // Local absolute paths live only in the git-ignored .env file.
    executablePath: process.env.GODOT_RUNTIME_PATH ?? '',
    projectPath: resolve(
      process.env.GODOT_RUNTIME_PROJECT_PATH ?? './godot_project/_wired',
    ),
    portStart: intFromEnv('GODOT_ROOM_PORT_START', 19100),
    portEnd: intFromEnv('GODOT_ROOM_PORT_END', 19199),
    bindAddress: process.env.GODOT_ROOM_BIND ?? '127.0.0.1',
    idleTimeoutMs: intFromEnv('GODOT_ROOM_IDLE_TIMEOUT_MS', 300_000),
    shutdownGraceMs: intFromEnv('GODOT_ROOM_SHUTDOWN_GRACE_MS', 10_000),
    startTimeoutMs: intFromEnv('GODOT_ROOM_START_TIMEOUT_MS', 20_000),
    ticketTtlSec: intFromEnv('GODOT_GAME_TICKET_TTL_SEC', 60),
    ticketSecret: process.env.WIRED_GAME_TICKET_SECRET ?? '',
    ticketRateLimit: intFromEnv('GODOT_GAME_TICKET_RATE_LIMIT', 20),
    ticketRateLimitWindowMs: intFromEnv(
      'GODOT_GAME_TICKET_RATE_WINDOW_MS',
      60_000,
    ),
    // The runtime fetches package manifests from the backend over loopback.
    // GODOT_ROOM_API_URL is required when the backend port differs from PORT
    // (for example behind a proxy) or when it listens on another interface.
    apiUrl:
      process.env.GODOT_ROOM_API_URL ??
      `http://127.0.0.1:${intFromEnv('PORT', 3000)}`,
    stateDir: resolve(
      process.env.GODOT_ROOM_STATE_DIR ?? './storage/godot_rooms',
    ),
    publicWsBaseUrl: process.env.GODOT_ROOM_PUBLIC_WS_BASE ?? '',
    logBufferLines: intFromEnv('GODOT_ROOM_LOG_BUFFER_LINES', 2000),
    // The Web export is a build artifact and must live outside
    // godot_project/_wired: that directory is the base project served to every
    // room editor and to the runtime, so a build there would be imported,
    // copied into the editor FS and scanned by Godot.
    exportDir: resolve(
      process.env.GODOT_GAME_EXPORT_DIR ?? './game_export/web',
    ),
  },
});
export default config;
