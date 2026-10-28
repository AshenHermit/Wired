export interface AppConfig {
  nodeEnv: 'development' | 'production';
  db: {
    host: string;
    port: number;
    password: string;
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
    stateDir: string;
    publicWsBaseUrl: string;
    logBufferLines: number;
  };
}
