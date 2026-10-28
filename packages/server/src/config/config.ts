import { AppConfig } from './config.interface';

const intFromEnv = (name: string, fallback: number): number => {
  const value = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
};

const config: () => AppConfig = () => ({
  nodeEnv: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  db: {
    host: process.env.DB_HOST ?? 'db',
    port: parseInt(process.env.DB_PORT ?? '5432'),
    password: process.env.DB_PASSWORD ?? 'postgres',
    entities: [process.env.DB_ENTITIES ?? 'dist/**/*.entity.{ts,js}'],
    sync: process.env.DB_SYNC == '1',
  },
  site: {
    commonDomain: process.env.COMMON_DOMAIN ?? 'localhost',
    host: process.env.SITE_HOST ?? 'http://localhost:3001',
    authSecret: process.env.AUTH_SECRET ?? 'secret',
    authCookieName: process.env.AUTH_COOKIE_NAME ?? 'access_token',
  },
  storage: {
    dir: process.env.STORAGE_DIR ?? './storage',
    packagesFilesDir:
      (process.env.STORAGE_DIR ?? './storage') +
      '/' +
      (process.env.PACKAGES_FILES_DIR ?? 'packages_files'),
  },
  godot: {
    editorPath: process.env.GODOT_EDITOR_PATH ?? './godot_editor',
    projectPath: process.env.GODOT_PROJECT_PATH ?? './godot_project',
  },
  godotRuntime: {
    // Local absolute paths live only in the git-ignored .env file.
    executablePath: process.env.GODOT_RUNTIME_PATH ?? '',
    projectPath:
      process.env.GODOT_RUNTIME_PROJECT_PATH ?? './godot_project/_wired',
    portStart: intFromEnv('GODOT_ROOM_PORT_START', 19100),
    portEnd: intFromEnv('GODOT_ROOM_PORT_END', 19199),
    bindAddress: process.env.GODOT_ROOM_BIND ?? '127.0.0.1',
    idleTimeoutMs: intFromEnv('GODOT_ROOM_IDLE_TIMEOUT_MS', 300_000),
    shutdownGraceMs: intFromEnv('GODOT_ROOM_SHUTDOWN_GRACE_MS', 10_000),
    startTimeoutMs: intFromEnv('GODOT_ROOM_START_TIMEOUT_MS', 20_000),
    ticketTtlSec: intFromEnv('GODOT_GAME_TICKET_TTL_SEC', 60),
    ticketSecret: process.env.WIRED_GAME_TICKET_SECRET ?? '',
    stateDir: process.env.GODOT_ROOM_STATE_DIR ?? './storage/godot_rooms',
    publicWsBaseUrl: process.env.GODOT_ROOM_PUBLIC_WS_BASE ?? '',
    logBufferLines: intFromEnv('GODOT_ROOM_LOG_BUFFER_LINES', 2000),
  },
});
export default config;
