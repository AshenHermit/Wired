import type { AppConfig } from 'src/config/config.interface';

/**
 * Lifecycle of a Godot server process dedicated to one Wired room.
 *
 * The registry key is `roomId + port`, not `roomId` alone: a room may be
 * restarted on the same port after its previous process exited, and two
 * rooms must never share a runtime.
 */
export type RoomRuntimeState =
  'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

/**
 * The runtime's configuration, owned by `AppConfig`.
 *
 * A separate shape here used to restate all nineteen knobs, so a new setting
 * had to be duplicated and could drift from the one the server actually loads.
 */
export type GodotRuntimeConfig = AppConfig['godotRuntime'];

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

/**
 * Local notification sink for protocol facts observed on the runtime control
 * channel. Delivery is best-effort: consumers must treat these callbacks as a
 * hint to reconcile against persisted package manifests, not as a transport
 * with guaranteed delivery.
 */
export interface RuntimeObserver {
  onRuntimeReady?(roomId: string): void;
  onPeerAuthenticated?(roomId: string, peer: number): void;
  onPeerLeft?(roomId: string, peer: number): void;
  onPackagesApplied?(
    roomId: string,
    packageId: number,
    revision: number,
    files: number,
  ): void;
  onPackagesFailed?(
    roomId: string,
    packageId: number,
    revision: number,
    error: string,
  ): void;
  onClientPackagesReady?(
    roomId: string,
    peer: number,
    packageId: number,
    revision: number,
  ): void;
  onClientPackagesFailed?(
    roomId: string,
    peer: number,
    packageId: number,
    revision: number,
    error: string,
  ): void;
}
