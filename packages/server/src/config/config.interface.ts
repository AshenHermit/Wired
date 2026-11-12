export interface AppConfig {
  nodeEnv: 'development' | 'production';
  /** Port the HTTP server listens on. */
  port: number;
  db: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    sync: boolean;
    entities: string[];
  };
  site: {
    commonDomain: string;
    apiDomain: string;
    host: string;
    /**
     * Origin allowed to call the API with credentials, or `null` when
     * `SITE_HOST` is unset and any origin may call it anonymously.
     */
    corsOrigin: string | null;
    authSecret: string;
    authCookieName: string;
  };
  auth: {
    googleClientId: string;
    googleClientSecret: string;
    googleCallbackUrl?: string;
  };
  storage: {
    dir: string;
    packagesFilesDir: string;
  };
  godot: {
    editorPath: string;
    projectPath: string;
  };
  godotRuntime: {
    executablePath: string;
    projectPath: string;
    portStart: number;
    portEnd: number;
    bindAddress: string;
    idleTimeoutMs: number;
    shutdownGraceMs: number;
    startTimeoutMs: number;
    ticketTtlSec: number;
    ticketSecret: string;
    ticketRateLimit: number;
    ticketRateLimitWindowMs: number;
    stateSaveIntervalMs: number;
    /** Base URL of this backend as seen by the local Godot runtime. */
    apiUrl: string;
    stateDir: string;
    /**
     * Public WebSocket base for deployed environments. Supports `{room}` and
     * `{port}`. Empty derives the endpoint from `apiUrl` outside production;
     * production requires this value.
     */
    publicWsBaseUrl: string;
    /** Concurrent proxied game sockets allowed per room. */
    wsMaxClientsPerRoom: number;
    /** Concurrent proxied game sockets allowed for the whole backend. */
    wsMaxTotal: number;
    logBufferLines: number;
    /** Directory of the generated Web export, outside the Godot project. */
    exportDir: string;
  };
  packages: {
    readSecret: string;
    readTtlSec: number;
    /** Store published revisions as commits in a per-package bare git repo. */
    gitStorage: boolean;
    /** Artifact builds allowed per `(package, revision, room)` per window. */
    artifactBuildRateLimit: number;
    artifactBuildRateWindowMs: number;
  };
  /** Headless glTF bake used while building runtime artifacts. */
  assetBake: {
    /** Directory that holds `project.godot`, `bake_tool.gd` and `wired_bake.gd`. */
    projectPath: string;
    executablePath: string;
    timeoutMs: number;
    maxConcurrency: number;
    cacheDir: string;
    cacheMaxBytes: number;
  };
}
