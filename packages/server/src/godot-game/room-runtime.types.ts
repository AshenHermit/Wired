/**
 * Lifecycle of a Godot server process dedicated to one Wired room.
 *
 * The registry key is `roomId + port`, not `roomId` alone: a room may be
 * restarted on the same port after its previous process exited, and two
 * rooms must never share a runtime.
 */
export type RoomRuntimeState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface GodotRuntimeConfig {
  /** Godot executable. Server-side configuration only; never client input. */
  executablePath: string;
  /** Godot project directory launched for each room. */
  projectPath: string;
  /** Inclusive local port range reserved for room runtimes. */
  portStart: number;
  portEnd: number;
  bindAddress: string;
  /** Stop an unused room after this much time with no authenticated players. */
  idleTimeoutMs: number;
  /** Time Godot gets to save state and exit after a shutdown command. */
  shutdownGraceMs: number;
  /** Time to wait for the `WIRED_SERVER_READY` line. */
  startTimeoutMs: number;
  ticketTtlSec: number;
  ticketSecret: string;
  /** Ticket issues allowed per user and room inside one window. 0 disables. */
  ticketRateLimit: number;
  ticketRateLimitWindowMs: number;
  /** Directory for per-room state and runtime logs. */
  stateDir: string;
  /**
   * Public WebSocket base for deployed environments. Supports `{room}` and
   * `{port}` placeholders. Empty means the local `ws://127.0.0.1:<port>`.
   */
  publicWsBaseUrl: string;
  logBufferLines: number;
}

export interface RoomRuntimeInfo {
  key: string;
  roomId: string;
  port: number;
  pid: number | null;
  state: RoomRuntimeState;
  endpoint: string;
  startedAt: string | null;
  stoppedAt: string | null;
  activePlayers: number;
  exitCode: number | null;
  error: string | null;
}

export interface RoomConnection extends RoomRuntimeInfo {
  /** Short-lived, single-use ticket for the Godot handshake. */
  ticket: string;
  ticketExpiresAt: number;
}

export interface RuntimeSpawnOptions {
  executablePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Minimal child-process surface used by the lifecycle service, so the
 * lifecycle can be tested without spawning Godot.
 */
export interface RuntimeProcess {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  onExit(
    callback: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  onError(callback: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export abstract class RuntimeProcessFactory {
  abstract spawn(options: RuntimeSpawnOptions): RuntimeProcess;
}
