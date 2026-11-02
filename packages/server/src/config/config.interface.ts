export interface AppConfig {
  nodeEnv: 'development' | 'production';
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
    host: string;
    authSecret: string;
    authCookieName: string;
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
  };
}
