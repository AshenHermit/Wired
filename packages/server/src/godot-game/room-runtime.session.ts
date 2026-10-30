import { Logger } from '@nestjs/common';
import { RoomRuntimeConfiguration } from './room-runtime.configuration';
import { RoomRuntimeError } from './room-runtime.errors';
import { RoomRuntimeLog } from './room-runtime.log';
import { RoomRuntimeRegistry } from './room-runtime.registry';
import { RuntimeRecord } from './room-runtime.record';
import {
  GodotRuntimeConfig,
  RoomRuntimeInfo,
  RuntimeProcessFactory,
} from './room-runtime.types';
import { parseRuntimeLine, RuntimeLineEvent } from './room-runtime.line-parser';

const FORCE_KILL_WAIT_MS = 2_000;
const HANDSHAKE_LEASE_SLACK_MS = 5_000;
// Keep in sync with AUTH_TIMEOUT_SEC in the Godot network script.
const AUTH_TIMEOUT_SEC = 10;

export interface RoomRuntimeSessionOptions {
  roomId: string;
  port: number;
  config: GodotRuntimeConfig;
  configuration: RoomRuntimeConfiguration;
  processFactory: RuntimeProcessFactory;
  registry: RoomRuntimeRegistry;
  logger: Logger;
  paths: { projectPath: string; stateDir: string };
  /** Best-effort local signal, never a delivery guarantee. */
  onEvent?: (event: RuntimeLineEvent) => void;
}

/**
 * One Godot process for one room, from spawn to exit.
 *
 * The session owns everything that belongs to a single runtime: the process,
 * its stdout protocol, readiness, the handshake lease, idle shutdown and the
 * graceful/forced stop sequence. RoomRuntimeService only allocates a port,
 * keeps the `roomId -> session` map and mints tickets, so the two state
 * machines (room lookup and process lifecycle) no longer share one class.
 *
 * Every runtime has its own port and key `roomId:port`; a restarted room gets
 * a fresh session and cannot inherit timers or peers from the previous one.
 */
export class RoomRuntimeSession {
  readonly record: RuntimeRecord;

  constructor(private readonly options: RoomRuntimeSessionOptions) {
    this.record = this.createRecord();
  }

  get roomId(): string {
    return this.record.roomId;
  }

  get port(): number {
    return this.record.port;
  }

  get state(): RuntimeRecord['state'] {
    return this.record.state;
  }

  get readyPromise(): Promise<void> {
    return this.record.readyPromise;
  }

  isActive(): boolean {
    return (
      this.record.state === 'starting' ||
      this.record.state === 'running' ||
      this.record.state === 'stopping'
    );
  }

  info(): RoomRuntimeInfo {
    return {
      key: this.record.key,
      roomId: this.record.roomId,
      port: this.record.port,
      pid: this.record.pid,
      state: this.record.state,
      endpoint: this.options.configuration.buildEndpoint(
        this.options.config,
        this.record.roomId,
        this.record.port,
      ),
      startedAt: this.record.startedAt,
      stoppedAt: this.record.stoppedAt,
      activePlayers: this.record.activePlayers,
      exitCode: this.record.exitCode,
      error: this.record.error,
    };
  }

  logLines(): string[] {
    return this.record.log.getLines();
  }

  start(): void {
    const { config, paths } = this.options;
    this.record.log.open(paths.stateDir);
    this.appendLog(
      `[wired] starting room=${this.record.roomId} port=${this.record.port} key=${this.record.key}`,
    );

    this.record.startTimer = setTimeout(() => {
      if (this.record.state !== 'starting') {
        return;
      }
      this.failRecord(
        new RoomRuntimeError(
          'start_failed',
          `Godot runtime did not report WIRED_SERVER_READY within ${config.startTimeoutMs}ms`,
          this.record.roomId,
          this.record.port,
        ),
      );
      this.terminate();
    }, config.startTimeoutMs);

    try {
      const child = this.options.processFactory.spawn(
        this.options.configuration.createSpawnOptions(
          config,
          this.record.roomId,
          this.record.port,
          paths,
        ),
      );
      this.record.process = child;
      this.record.pid = child.pid ?? null;
      child.onExit((code, signal) => this.handleExit(code, signal));
      child.onError((error) => this.handleSpawnError(error));
      this.attachLines(child.stdout, 'stdout');
      this.attachLines(child.stderr, 'stderr');
    } catch (error) {
      this.handleSpawnError(this.toError(error));
    }
  }

  /**
   * Validates that this runtime can accept a player and extends the handshake
   * lease for a peerless runtime. Returns the ticket TTL to mint, or undefined
   * when players are already connected and the idle timeout governs shutdown.
   */
  reserveConnection(): number | undefined {
    this.assertPlayable();
    this.renewHandshakeLease();
    return this.ticketTtlSec();
  }

  /**
   * Graceful stop: ask Godot to save state and exit over stdin, then force
   * kill only after the configured grace period.
   */
  stop(reason = 'requested'): Promise<void> {
    const record = this.record;
    if (record.state === 'stopped' || record.state === 'failed') {
      return Promise.resolve();
    }
    if (record.stopPromise) {
      return record.stopPromise;
    }

    record.stopRequested = true;
    record.state = 'stopping';
    this.clearTimers();
    if (!record.readySettled) {
      this.rejectReady(
        new RoomRuntimeError(
          'room_stopping',
          `Room ${record.roomId} is stopping`,
          record.roomId,
          record.port,
        ),
      );
    }

    record.stopPromise = this.performStop(reason).finally(() => {
      record.stopPromise = undefined;
    });
    return record.stopPromise;
  }

  private assertPlayable(): void {
    const record = this.record;
    if (record.state === 'stopping') {
      throw new RoomRuntimeError(
        'room_stopping',
        `Room ${record.roomId} is stopping; retry after it exits`,
        record.roomId,
        record.port,
      );
    }
    if (record.state !== 'running') {
      throw new RoomRuntimeError(
        'start_failed',
        record.error ?? `Room ${record.roomId} is not running`,
        record.roomId,
        record.port,
      );
    }
  }

  /**
   * A ticket minted near the end of the handshake lease would outlive the
   * runtime. Clamp it to the remaining window (the client has one second to
   * send hello, then the 10s auth timeout), or fail explicitly when there is
   * not enough time left for a handshake. Returns undefined for a runtime that
   * already has players, in which case the idle timeout governs shutdown.
   */
  private ticketTtlSec(): number | undefined {
    const record = this.record;
    if (record.activePlayers > 0) {
      return undefined;
    }

    const remainingSec = Math.floor(
      (record.handshakeLeaseUntil - Date.now()) / 1_000,
    );
    if (remainingSec <= AUTH_TIMEOUT_SEC + 1) {
      // Do not leave a window the client is told to retry into: stop this
      // runtime so the next attempt starts a fresh one.
      void this.stop('handshake_window_expired').catch(() => {
        // The exit handler still finalises the record; a failed stop must not
        // hide the actionable error below.
      });
      throw new RoomRuntimeError(
        'handshake_window_expired',
        `Room ${record.roomId} has only ${remainingSec}s left in its handshake window; it is restarting, retry in a moment`,
        record.roomId,
        record.port,
      );
    }

    return Math.min(this.options.config.ticketTtlSec, remainingSec - 1);
  }

  private createRecord(): RuntimeRecord {
    const { roomId, port, config, logger } = this.options;
    const key = `${roomId}:${port}`;
    const log = new RoomRuntimeLog(
      roomId,
      key,
      port,
      config.logBufferLines,
      logger,
    );
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    let resolveExit: () => void = () => undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    // The caller may not await the start immediately (e.g. shutdown first).
    void readyPromise.catch(() => undefined);

    return {
      key,
      roomId,
      port,
      state: 'starting',
      process: null,
      pid: null,
      log,
      startedAt: null,
      stoppedAt: null,
      exitCode: null,
      exitSignal: null,
      error: null,
      activePlayers: 0,
      authenticatedPeers: new Set<number>(),
      handshakeLeaseUntil: 0,
      stopRequested: false,
      forceKilled: false,
      readySettled: false,
      exitHandled: false,
      portReleased: false,
      readyPromise,
      resolveReady,
      rejectReady,
      exitPromise,
      resolveExit,
    };
  }

  // --- process output -----------------------------------------------------

  private attachLines(
    stream: NodeJS.ReadableStream | null,
    source: 'stdout' | 'stderr',
  ): void {
    if (!stream) {
      return;
    }
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        this.handleLine(line, source);
      }
    });
  }

  private handleLine(line: string, source: 'stdout' | 'stderr'): void {
    if (line.length === 0) {
      return;
    }
    this.appendLog(`[${source}] ${line}`);

    const event = parseRuntimeLine(line);
    if (!event) {
      return;
    }

    switch (event.kind) {
      case 'ready':
        this.handleReady(event.roomId, event.port);
        return;

      case 'auth':
        if (event.roomId !== this.record.roomId) {
          this.appendLog(
            `[wired] ignored auth for foreign room=${event.roomId}`,
          );
          return;
        }
        this.record.authenticatedPeers.add(event.peer);
        this.record.activePlayers = this.record.authenticatedPeers.size;
        // The handshake succeeded; from now on only real peers keep it alive.
        this.record.handshakeLeaseUntil = 0;
        this.clearIdleTimer();
        this.notify(event);
        return;

      case 'player-left':
        if (!this.record.authenticatedPeers.delete(event.peer)) {
          this.appendLog(
            `[wired] ignored departure of unauthenticated peer=${event.peer}`,
          );
          return;
        }
        this.record.activePlayers = this.record.authenticatedPeers.size;
        if (this.record.activePlayers === 0) {
          this.record.handshakeLeaseUntil = 0;
          this.scheduleIdleStop();
        }
        this.notify(event);
        return;

      case 'packages-applied':
      case 'packages-failed':
      case 'client-packages-ready':
      case 'client-packages-failed':
        this.notify(event);
        return;
    }
  }

  private handleReady(roomId: string, port: number): void {
    const record = this.record;
    if (record.state !== 'starting') {
      return;
    }

    if (roomId !== record.roomId || port !== record.port) {
      this.failRecord(
        new RoomRuntimeError(
          'start_failed',
          `Godot reported readiness for room=${roomId} port=${port}, expected room=${record.roomId} port=${record.port}`,
          record.roomId,
          record.port,
        ),
      );
      this.terminate();
      return;
    }

    this.clearStartTimer();
    record.state = 'running';
    record.startedAt = new Date().toISOString();
    this.resolveReady();
    this.appendLog(
      `[wired] running room=${record.roomId} port=${record.port} pid=${record.pid ?? 'unknown'}`,
    );
    // A room whose client never finishes the handshake must not live forever.
    if (record.activePlayers === 0) {
      this.scheduleIdleStop();
    }
    this.notify({ kind: 'ready', roomId: record.roomId, port: record.port });
  }

  /**
   * Writes one control command to the runtime. Returns false when the room is
   * not running or its input is already closed; callers retry on reconciliation
   * instead of assuming delivery.
   */
  sendCommand(command: string): boolean {
    const record = this.record;
    if (record.state !== 'running' || !record.process?.stdin) {
      return false;
    }
    try {
      record.process.stdin.write(`${command}\n`);
      this.appendLog(`[wired] control -> ${command}`);
      return true;
    } catch (error) {
      this.appendLog(
        `[wired] control write failed: ${this.errorMessage(error)}`,
      );
      return false;
    }
  }

  /** Asks Godot to download and apply an exact published package revision. */
  sendPackage(packageId: number, revision: number): boolean {
    if (
      !Number.isInteger(packageId) ||
      packageId <= 0 ||
      !Number.isInteger(revision) ||
      revision <= 0
    ) {
      return false;
    }
    return this.sendCommand(`package ${packageId} ${revision}`);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const record = this.record;
    if (record.exitHandled) {
      return;
    }
    record.exitHandled = true;
    record.exitCode = code;
    record.exitSignal = signal;
    record.stoppedAt = new Date().toISOString();
    this.clearTimers();
    this.releasePort();
    if (code === 3) {
      // Remember the occupied port briefly; otherwise every new room would
      // retry the same lowest port and fail while the rest of the range is free.
      this.options.registry.markPortUnavailable(record.port);
    }

    const wasStarting = record.state === 'starting';
    if (record.state === 'failed') {
      // The failure reason was already recorded (spawn error, timeout, ...).
    } else if (record.stopRequested) {
      record.state = 'stopped';
    } else if (code === 0) {
      record.state = 'stopped';
      record.error = 'Godot runtime exited unexpectedly with code 0';
    } else {
      record.state = 'failed';
      record.error ??= this.describeExit(code);
    }

    if (wasStarting && !record.readySettled) {
      this.rejectReady(
        new RoomRuntimeError(
          'start_failed',
          record.error ?? this.describeExit(code),
          record.roomId,
          record.port,
        ),
      );
    }

    this.appendLog(
      `[wired] exited room=${record.roomId} port=${record.port} code=${code ?? 'null'} signal=${signal ?? 'none'} state=${record.state}`,
    );
    record.log.close();
    record.resolveExit();
  }

  private handleSpawnError(error: Error): void {
    const record = this.record;
    if (record.exitHandled) {
      return;
    }
    record.exitHandled = true;
    record.state = 'failed';
    record.error = `Failed to start Godot runtime: ${error.message}`;
    this.clearTimers();
    this.releasePort();
    this.rejectReady(
      new RoomRuntimeError(
        'start_failed',
        record.error,
        record.roomId,
        record.port,
      ),
    );
    this.appendLog(`[wired] ${record.error}`);
    record.log.close();
    record.resolveExit();
  }

  /**
   * Records the failure and makes waiting callers fail. The process may still
   * be alive; the caller kills it separately.
   */
  private failRecord(error: RoomRuntimeError): void {
    const record = this.record;
    if (record.state === 'failed') {
      return;
    }
    record.state = 'failed';
    record.error = error.message;
    record.stoppedAt = new Date().toISOString();
    this.clearTimers();
    // Keep the port reserved until the process really exits. terminate() may
    // be asynchronous, and handing the same port to the next spawn while the
    // old process is still bound would make that start fail with code 3.
    this.rejectReady(error);
    this.appendLog(`[wired] failure room=${record.roomId}: ${error.message}`);
  }

  private terminate(): void {
    if (this.record.exitHandled || !this.record.process) {
      return;
    }
    try {
      this.record.process.kill();
    } catch (error) {
      this.options.logger.warn(
        `Failed to kill room ${this.record.roomId} after start failure: ${this.errorMessage(error)}`,
      );
    }
  }

  private describeExit(code: number | null): string {
    if (code === 2) {
      return 'Godot runtime exited with code 2: WIRED_GAME_TICKET_SECRET is not configured';
    }
    if (code === 3) {
      return `Godot runtime exited with code 3: port ${this.record.port} is already in use`;
    }
    return `Godot runtime exited with code ${code ?? 'null'}`;
  }

  // --- idle and shutdown --------------------------------------------------

  private scheduleIdleStop(): void {
    const record = this.record;
    const { config } = this.options;
    if (
      record.idleTimer ||
      record.state !== 'running' ||
      config.idleTimeoutMs <= 0
    ) {
      return;
    }
    const leaseRemaining = record.handshakeLeaseUntil - Date.now();
    const delay = leaseRemaining > 0 ? leaseRemaining : config.idleTimeoutMs;
    this.appendLog(
      `[wired] no authenticated players; idle stop scheduled in ${delay}ms`,
    );
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.state !== 'running' || record.activePlayers > 0) {
        return;
      }
      if (record.handshakeLeaseUntil > Date.now()) {
        // A client is still inside its bounded handshake window.
        this.scheduleIdleStop();
        return;
      }
      void this.stop('idle_timeout').catch((error) => {
        this.options.logger.warn(
          `Idle stop failed for room ${record.roomId}: ${this.errorMessage(error)}`,
        );
      });
    }, delay);
    record.idleTimer.unref?.();
  }

  /**
   * Grants one bounded handshake window per peerless runtime, sized by the
   * ticket lifetime and capped by the idle timeout. A second request while the
   * window is open gets a fresh ticket but does not move the deadline.
   */
  private renewHandshakeLease(): void {
    const record = this.record;
    if (record.activePlayers > 0) {
      return;
    }
    const now = Date.now();
    if (record.handshakeLeaseUntil > now) {
      return;
    }
    const config = this.options.config;
    const leaseMs = config.ticketTtlSec * 1_000 + HANDSHAKE_LEASE_SLACK_MS;
    const boundedMs =
      config.idleTimeoutMs > 0
        ? Math.min(leaseMs, config.idleTimeoutMs)
        : leaseMs;
    record.handshakeLeaseUntil = now + boundedMs;
    this.clearIdleTimer();
    this.scheduleIdleStop();
  }

  private async performStop(reason: string): Promise<void> {
    const record = this.record;
    const config = this.options.config;
    this.appendLog(
      `[wired] stopping room=${record.roomId} port=${record.port} reason=${reason}`,
    );

    if (!record.process) {
      record.state = 'stopped';
      this.releasePort();
      record.log.close();
      record.resolveExit();
      return;
    }

    try {
      record.process.stdin?.write('shutdown\n');
    } catch (error) {
      this.appendLog(
        `[wired] failed to send shutdown command: ${this.errorMessage(error)}`,
      );
    }

    const exitedGracefully = await this.waitForExit(config.shutdownGraceMs);
    if (exitedGracefully) {
      return;
    }

    record.forceKilled = true;
    this.appendLog(
      `[wired] graceful shutdown timed out after ${config.shutdownGraceMs}ms; forcing room=${record.roomId} port=${record.port}`,
    );
    this.options.logger.warn(
      `Forcing shutdown of room ${record.roomId} on port ${record.port} after ${config.shutdownGraceMs}ms grace period`,
    );
    try {
      record.process.kill();
    } catch (error) {
      this.appendLog(`[wired] force kill failed: ${this.errorMessage(error)}`);
    }

    const exitedAfterKill = await this.waitForExit(FORCE_KILL_WAIT_MS);
    if (!exitedAfterKill) {
      record.state = 'failed';
      record.error = `Godot runtime did not exit within ${FORCE_KILL_WAIT_MS}ms after force kill`;
      record.stoppedAt = new Date().toISOString();
      // The process may still be alive and bound to its port. Keep the port
      // reserved and the log open; the real exit callback finalizes the record.
      // A new runtime for the same room will therefore use another free port.
      this.appendLog(`[wired] ${record.error}`);
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.record.exitHandled) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.record.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // --- bookkeeping --------------------------------------------------------

  private releasePort(): void {
    this.options.registry.releasePort(this.record);
  }

  private clearTimers(): void {
    this.clearStartTimer();
    this.clearIdleTimer();
  }

  private clearStartTimer(): void {
    if (this.record.startTimer) {
      clearTimeout(this.record.startTimer);
      this.record.startTimer = undefined;
    }
  }

  private clearIdleTimer(): void {
    if (this.record.idleTimer) {
      clearTimeout(this.record.idleTimer);
      this.record.idleTimer = undefined;
    }
  }

  private resolveReady(): void {
    if (this.record.readySettled) {
      return;
    }
    this.record.readySettled = true;
    this.record.resolveReady();
  }

  private rejectReady(error: Error): void {
    if (this.record.readySettled) {
      return;
    }
    this.record.readySettled = true;
    this.record.rejectReady(error);
  }

  private appendLog(line: string): void {
    this.record.log.append(line);
  }

  private notify(event: RuntimeLineEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      // A consumer bug must never break the runtime state machine.
      this.appendLog(
        `[wired] event observer failed: ${this.errorMessage(error)}`,
      );
    }
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private errorMessage(error: unknown): string {
    return this.toError(error).message;
  }
}
