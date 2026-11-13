import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppConfig } from './config.interface';

const intFromEnv = (name: string, fallback: number): number => {
  const value = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
};

// `pnpm fetch:runtime` installs a versioned build and records its path in this
// manifest. Explicit environment configuration still wins.
const downloadedRuntime = (): string => {
  const root = resolve('./godot_runtime');
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, 'runtime.json'), 'utf8'),
    ) as { executable?: unknown };
    if (typeof manifest.executable !== 'string') {
      return '';
    }
    const executable = resolve(root, manifest.executable);
    return existsSync(executable) ? executable : '';
  } catch {
    return '';
  }
};

// Filesystem paths are resolved once, when the config is built, so services
// and controllers never have to guess the caller's cwd. Tests and Docker can
// still override every path through the environment.
const storageDir = () => resolve(process.env.STORAGE_DIR ?? './storage');

/**
 * The HTTP port, also used to build the loopback API URL the runtime calls.
 */
const serverPort = () => intFromEnv('PORT', 3000);

const siteHost = () => process.env.SITE_HOST?.trim() || null;

const config: () => AppConfig = () => ({
  nodeEnv: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  port: serverPort(),
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
    apiDomain: 'api.' + (process.env.COMMON_DOMAIN ?? 'localhost'),
    host: siteHost() ?? 'http://localhost:3001',
    corsOrigin: siteHost(),
    authSecret: process.env.AUTH_SECRET ?? 'secret',
    authCookieName: process.env.AUTH_COOKIE_NAME ?? 'access_token',
  },
  auth: {
    googleClientId: process.env.GOOGLE_AUTH_CLIENT_ID ?? 'clientId',
    googleClientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET ?? 'secret',
    googleCallbackUrl: process.env.GOOGLE_AUTH_CALLBACK,
  },
  storage: {
    dir: storageDir(),
    packagesFilesDir: join(
      storageDir(),
      process.env.PACKAGES_FILES_DIR ?? 'packages_files',
    ),
  },
  // Raw glTF cannot be loaded by an exported game, so artifacts bake it into a
  // self-contained scene with the same headless Godot binary the rooms use.
  assetBake: {
    projectPath: resolve(process.env.GODOT_BAKE_PROJECT_PATH ?? './godot_bake'),
    executablePath: process.env.GODOT_RUNTIME_PATH || downloadedRuntime(),
    timeoutMs: intFromEnv('GODOT_BAKE_TIMEOUT_MS', 30_000),
    maxConcurrency: intFromEnv('GODOT_BAKE_MAX_CONCURRENCY', 1),
    cacheDir: join(
      storageDir(),
      process.env.PACKAGES_FILES_DIR ?? 'packages_files',
      'bake-cache',
    ),
    cacheMaxBytes: intFromEnv('GODOT_BAKE_CACHE_MAX_BYTES', 536_870_912),
  },
  godot: {
    editorPath: resolve(process.env.GODOT_EDITOR_PATH ?? './godot_editor'),
    projectPath: resolve(process.env.GODOT_PROJECT_PATH ?? './godot_project'),
  },
  godotRuntime: {
    // Local absolute paths live only in the git-ignored .env file.
    executablePath: process.env.GODOT_RUNTIME_PATH || downloadedRuntime(),
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
    stateSaveIntervalMs: intFromEnv(
      'GODOT_ROOM_STATE_SAVE_INTERVAL_MS',
      30_000,
    ),
    // The runtime fetches package manifests from the backend over loopback.
    // GODOT_ROOM_API_URL is required when the backend port differs from PORT
    // (for example behind a proxy) or when it listens on another interface.
    apiUrl:
      process.env.GODOT_ROOM_API_URL ?? `http://127.0.0.1:${serverPort()}`,
    stateDir: resolve(
      process.env.GODOT_ROOM_STATE_DIR ?? './storage/godot_rooms',
    ),
    publicWsBaseUrl: process.env.GODOT_ROOM_PUBLIC_WS_BASE ?? '',
    wsMaxClientsPerRoom: intFromEnv('GODOT_ROOM_WS_MAX_CLIENTS_PER_ROOM', 32),
    wsMaxTotal: intFromEnv('GODOT_ROOM_WS_MAX_TOTAL', 512),
    logBufferLines: intFromEnv('GODOT_ROOM_LOG_BUFFER_LINES', 2000),
    // The Web export is a build artifact and must live outside
    // godot_project/_wired: that directory is the base project served to every
    // room editor and to the runtime, so a build there would be imported,
    // copied into the editor FS and scanned by Godot.
    exportDir: resolve(
      process.env.GODOT_GAME_EXPORT_DIR ?? './game_export/web',
    ),
  },
  packages: {
    readSecret:
      process.env.WIRED_PACKAGE_READ_SECRET ??
      process.env.WIRED_GAME_TICKET_SECRET ??
      '',
    readTtlSec: intFromEnv('WIRED_PACKAGE_READ_TTL_SEC', 900),
    // Хранилище ревизий в git. Выкат: сначала образ с флагом 0, затем
    // `packages:git-migrate -- --all`; после миграции — 1 и перезапуск.
    // Откат — снова 0: каталоги revisions/<n> живут до `packages:git-cleanup`.
    gitStorage: process.env.WIRED_PACKAGE_GIT_STORAGE === '1',
    gitGcExpire: process.env.WIRED_PACKAGE_GIT_GC_EXPIRE ?? '2.weeks.ago',
    gitGcIntervalMs: intFromEnv(
      'WIRED_PACKAGE_GIT_GC_INTERVAL_MS',
      24 * 60 * 60 * 1000,
    ),
    artifactBuildRateLimit: intFromEnv('WIRED_ARTIFACT_BUILD_RATE_LIMIT', 10),
    artifactBuildRateWindowMs: intFromEnv(
      'WIRED_ARTIFACT_BUILD_RATE_WINDOW_MS',
      60_000,
    ),
  },
});
export default config;
