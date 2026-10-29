import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { GameTicketService } from './game-ticket.service';
import { RoomRuntimeConfiguration } from './room-runtime.configuration';
import { RoomRuntimeError } from './room-runtime.errors';
import { RoomRuntimeLog } from './room-runtime.log';
import { RoomRuntimeRegistry } from './room-runtime.registry';
import { RuntimeRecord } from './room-runtime.record';
import {
  RoomConnection,
  RoomRuntimeInfo,
  RuntimeProcessFactory,
} from './room-runtime.types';
import { parseRuntimeLine } from './room-runtime.line-parser';

const FORCE_KILL_WAIT_MS = 2_000;
const HANDSHAKE_LEASE_SLACK_MS = 5_000;
// Keep in sync with AUTH_TIMEOUT_SEC in the Godot network script.
const AUTH_TIMEOUT_SEC = 10;

/**
 * Owns the in-memory registry of Godot room servers.
 *
 * One runtime exists per room at a time. Concurrent connection requests share
 * the same in-flight start (single-flight), so parallel tabs cannot spawn
 * duplicate processes. The registry key is `roomId:port`, which keeps a
 * restarted room distinguishable from its previous process.
 */
@Injectable()
export class RoomRuntimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RoomRuntimeService.name);
  private readonly registry = new RoomRuntimeRegistry();
  private readonly runtimeConfiguration: RoomRuntimeConfiguration;

  constructor(
    private readonly configService: AppConfigService,
    private readonly processFactory: RuntimeProcessFactory,
    private readonly tickets: GameTicketService,
  ) {
    this.runtimeConfiguration = new RoomRuntimeConfiguration(configService);
  }

  /**
   * Returns a ready runtime for the room, starting the process if needed.
   * Rejects with an explicit lifecycle error when the room cannot start; it
   * never falls back to a "maybe works" endpoint.
   */
  async getConnection(roomId: string): Promise<RoomConnection> {
    const record = this.ensureRuntime(roomId);
    await record.readyPromise;
    this.assertPlayable(record);

    // Opening the game tab is itself an intent to join, but only one bounded
    // lease per peerless runtime: repeated calls must not keep it alive forever.
    this.renewHandshakeLease(record);

    const ticketTtlSec = this.ticketTtlSec(record);

    const ticket = this.tickets.mint(roomId, ticketTtlSec);
    return {
      ...this.toInfo(record),
      ticket: ticket.ticket,
      ticketExpiresAt: ticket.expiresAt,
    };
  }

  private assertPlayable(record: RuntimeRecord): void {
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
  private ticketTtlSec(record: RuntimeRecord): number | undefined {
    if (record.activePlayers > 0) {
      return undefined;
    }

    const remainingSec = Math.floor(
      (record.handshakeLeaseUntil - Date.now()) / 1_000,
    );
    if (remainingSec <= AUTH_TIMEOUT_SEC + 1) {
      // Do not leave a window the client is told to retry into: stop this
      // runtime so the next attempt starts a fresh one.
      void this.stopRoom(record.roomId, 'handshake_window_expired').catch(
        () => {
          // The exit handler still finalises the record; a failed stop must not
          // hide the actionable error below.
        },
      );
      throw new RoomRuntimeError(
        'handshake_window_expired',
        `Room ${record.roomId} has only ${remainingSec}s left in its handshake window; it is restarting, retry in a moment`,
        record.roomId,
        record.port,
      );
    }

    return Math.min(
      this.configService.godotRuntime.ticketTtlSec,
      remainingSec - 1,
    );
  }

  /** Current runtime status; never starts a process. */
  getRuntime(roomId: string): RoomRuntimeInfo | null {
    const record = this.registry.get(roomId);
    return record ? this.toInfo(record) : null;
  }

  listRuntimes(): RoomRuntimeInfo[] {
    return this.registry.list().map((record) => this.toInfo(record));
  }

  getLogs(roomId: string): string[] {
    return this.registry.get(roomId)?.log.getLines() ?? [];
  }

  /**
   * Graceful stop: ask Godot to save state and exit over stdin, then force
   * kill only after the configured grace period.
   */
  stopRoom(roomId: string, reason = 'requested'): Promise<void> {
    const record = this.registry.get(roomId);
    if (!record) {
      return Promise.reject(
        new RoomRuntimeError(
          'room_not_running',
          `Room ${roomId} has no runtime`,
          roomId,
        ),
      );
    }
    if (record.state === 'stopped' || record.state === 'failed') {
      return Promise.resolve();
    }
    if (record.stopPromise) {
      return record.stopPromise;
    }

    record.stopRequested = true;
    record.state = 'stopping';
    this.clearTimers(record);
    if (!record.readySettled) {
      this.rejectReady(
        record,
        new RoomRuntimeError(
          'room_stopping',
          `Room ${roomId} is stopping`,
          roomId,
          record.port,
        ),
      );
    }

    record.stopPromise = this.performStop(record, reason).finally(() => {
      record.stopPromise = undefined;
    });
    return record.stopPromise;
  }

  /** Stops every room; used by Nest shutdown hooks so no process is orphaned. */
  async shutdownAll(): Promise<void> {
    const records = this.registry
      .list()
      .filter(
        (record) =>
          record.state === 'starting' ||
          record.state === 'running' ||
          record.state === 'stopping',
      );
    await Promise.all(
      records.map((record) =>
        (record.state === 'stopping' && record.stopPromise
          ? record.stopPromise
          : this.stopRoom(record.roomId, 'backend_shutdown')
        ).catch((error) => {
          this.logger.error(
            `Failed to stop room ${record.roomId}: ${this.errorMessage(error)}`,
          );
        }),
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdownAll();
  }

  // --- startup ------------------------------------------------------------

  private ensureRuntime(roomId: string): RuntimeRecord {
    this.runtimeConfiguration.validateRoomId(roomId);
    const config = this.configService.godotRuntime;
    this.runtimeConfiguration.validate(config);
    const paths = this.runtimeConfiguration.resolvePaths(config);
    const { stateDir } = paths;

    const existing = this.registry.get(roomId);
    if (existing) {
      if (existing.state === 'starting' || existing.state === 'running') {
        return existing;
      }
      if (existing.state === 'stopping') {
        throw new RoomRuntimeError(
          'room_stopping',
          `Room ${roomId} is stopping; retry after it exits`,
          roomId,
          existing.port,
        );
      }
    }

    const port = this.registry.allocatePort(config);
    if (port === null) {
      throw new RoomRuntimeError(
        'start_failed',
        `No free port in range ${config.portStart}-${config.portEnd}`,
        roomId,
      );
    }

    const record = this.createRecord(roomId, port);
    this.registry.add(record);
    record.log.open(stateDir);
    this.appendLog(
      record,
      `[wired] starting room=${roomId} port=${port} key=${record.key}`,
    );

    record.startTimer = setTimeout(() => {
      if (record.state !== 'starting') {
        return;
      }
      this.failRecord(
        record,
        new RoomRuntimeError(
          'start_failed',
          `Godot runtime did not report WIRED_SERVER_READY within ${config.startTimeoutMs}ms`,
          roomId,
          port,
        ),
      );
      this.terminate(record);
    }, config.startTimeoutMs);

    try {
      const child = this.processFactory.spawn(
        this.runtimeConfiguration.createSpawnOptions(
          config,
          roomId,
          port,
          paths,
        ),
      );
      record.process = child;
      record.pid = child.pid ?? null;
      child.onExit((code, signal) => this.handleExit(record, code, signal));
      child.onError((error) => this.handleSpawnError(record, error));
      this.attachLines(record, child.stdout, 'stdout');
      this.attachLines(record, child.stderr, 'stderr');
    } catch (error) {
      this.handleSpawnError(record, this.toError(error));
    }

    return record;
  }

  private createRecord(roomId: string, port: number): RuntimeRecord {
    const key = `${roomId}:${port}`;
    const log = new RoomRuntimeLog(
      roomId,
      key,
      port,
      this.configService.godotRuntime.logBufferLines,
      this.logger,
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
    record: RuntimeRecord,
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
        this.handleLine(record, line, source);
      }
    });
  }

  private handleLine(
    record: RuntimeRecord,
    line: string,
    source: 'stdout' | 'stderr',
  ): void {
    if (line.length === 0) {
      return;
    }
    this.appendLog(record, `[${source}] ${line}`);

    const event = parseRuntimeLine(line);
    if (!event) {
      return;
    }

    switch (event.kind) {
      case 'ready':
        this.handleReady(record, event.roomId, event.port);
        return;

      case 'auth':
        if (event.roomId !== record.roomId) {
          this.appendLog(
            record,
            `[wired] ignored auth for foreign room=${event.roomId}`,
          );
          return;
        }
        record.authenticatedPeers.add(event.peer);
        record.activePlayers = record.authenticatedPeers.size;
        // The handshake succeeded; from now on only real peers keep it alive.
        record.handshakeLeaseUntil = 0;
        this.clearIdleTimer(record);
        return;

      case 'player-left':
        if (!record.authenticatedPeers.delete(event.peer)) {
          this.appendLog(
            record,
            `[wired] ignored departure of unauthenticated peer=${event.peer}`,
          );
          return;
        }
        record.activePlayers = record.authenticatedPeers.size;
        if (record.activePlayers === 0) {
          record.handshakeLeaseUntil = 0;
          this.scheduleIdleStop(record);
        }
        return;
    }
  }

  private handleReady(
    record: RuntimeRecord,
    roomId: string,
    port: number,
  ): void {
    if (record.state !== 'starting') {
      return;
    }
    if (roomId !== record.roomId || port !== record.port) {
      this.failRecord(
        record,
        new RoomRuntimeError(
          'start_failed',
          `Godot reported readiness for room=${roomId} port=${port}, expected room=${record.roomId} port=${record.port}`,
          record.roomId,
          record.port,
        ),
      );
      this.terminate(record);
      return;
    }

    this.clearStartTimer(record);
    record.state = 'running';
    record.startedAt = new Date().toISOString();
    this.resolveReady(record);
    this.appendLog(
      record,
      `[wired] running room=${record.roomId} port=${record.port} pid=${record.pid ?? 'unknown'}`,
    );
    // A room whose client never finishes the handshake must not live forever.
    if (record.activePlayers === 0) {
      this.scheduleIdleStop(record);
    }
  }

  private handleExit(
    record: RuntimeRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (record.exitHandled) {
      return;
    }
    record.exitHandled = true;
    record.exitCode = code;
    record.exitSignal = signal;
    record.stoppedAt = new Date().toISOString();
    this.clearTimers(record);
    this.releasePort(record);
    if (code === 3) {
      // Remember the occupied port briefly; otherwise every new room would
      // retry the same lowest port and fail while the rest of the range is free.
      this.registry.markPortUnavailable(record.port);
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
      record.error ??= this.describeExit(record, code);
    }

    if (wasStarting && !record.readySettled) {
      this.rejectReady(
        record,
        new RoomRuntimeError(
          'start_failed',
          record.error ?? this.describeExit(record, code),
          record.roomId,
          record.port,
        ),
      );
    }

    this.appendLog(
      record,
      `[wired] exited room=${record.roomId} port=${record.port} code=${code ?? 'null'} signal=${signal ?? 'none'} state=${record.state}`,
    );
    record.log.close();
    record.resolveExit();
  }

  private handleSpawnError(record: RuntimeRecord, error: Error): void {
    if (record.exitHandled) {
      return;
    }
    record.exitHandled = true;
    record.state = 'failed';
    record.error = `Failed to start Godot runtime: ${error.message}`;
    this.clearTimers(record);
    this.releasePort(record);
    this.rejectReady(
      record,
      new RoomRuntimeError(
        'start_failed',
        record.error,
        record.roomId,
        record.port,
      ),
    );
    this.appendLog(record, `[wired] ${record.error}`);
    record.log.close();
    record.resolveExit();
  }

  /**
   * Records the failure and makes waiting callers fail. The process may still
   * be alive; the caller kills it separately.
   */
  private failRecord(record: RuntimeRecord, error: RoomRuntimeError): void {
    if (record.state === 'failed') {
      return;
    }
    record.state = 'failed';
    record.error = error.message;
    record.stoppedAt = new Date().toISOString();
    this.clearTimers(record);
    // Keep the port reserved until the process really exits. terminate() may
    // be asynchronous, and handing the same port to the next spawn while the
    // old process is still bound would make that start fail with code 3.
    this.rejectReady(record, error);
    this.appendLog(
      record,
      `[wired] failure room=${record.roomId}: ${error.message}`,
    );
  }

  private terminate(record: RuntimeRecord): void {
    if (record.exitHandled || !record.process) {
      return;
    }
    try {
      record.process.kill();
    } catch (error) {
      this.logger.warn(
        `Failed to kill room ${record.roomId} after start failure: ${this.errorMessage(error)}`,
      );
    }
  }

  private describeExit(record: RuntimeRecord, code: number | null): string {
    if (code === 2) {
      return 'Godot runtime exited with code 2: WIRED_GAME_TICKET_SECRET is not configured';
    }
    if (code === 3) {
      return `Godot runtime exited with code 3: port ${record.port} is already in use`;
    }
    return `Godot runtime exited with code ${code ?? 'null'}`;
  }

  // --- idle and shutdown --------------------------------------------------

  private scheduleIdleStop(record: RuntimeRecord): void {
    const config = this.configService.godotRuntime;
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
      record,
      `[wired] no authenticated players; idle stop scheduled in ${delay}ms`,
    );
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.state !== 'running' || record.activePlayers > 0) {
        return;
      }
      if (record.handshakeLeaseUntil > Date.now()) {
        // A client is still inside its bounded handshake window.
        this.scheduleIdleStop(record);
        return;
      }
      void this.stopRoom(record.roomId, 'idle_timeout').catch((error) => {
        this.logger.warn(
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
  private renewHandshakeLease(record: RuntimeRecord): void {
    if (record.activePlayers > 0) {
      return;
    }
    const now = Date.now();
    if (record.handshakeLeaseUntil > now) {
      return;
    }
    const config = this.configService.godotRuntime;
    const leaseMs = config.ticketTtlSec * 1_000 + HANDSHAKE_LEASE_SLACK_MS;
    const boundedMs =
      config.idleTimeoutMs > 0
        ? Math.min(leaseMs, config.idleTimeoutMs)
        : leaseMs;
    record.handshakeLeaseUntil = now + boundedMs;
    this.clearIdleTimer(record);
    this.scheduleIdleStop(record);
  }

  private async performStop(
    record: RuntimeRecord,
    reason: string,
  ): Promise<void> {
    const config = this.configService.godotRuntime;
    this.appendLog(
      record,
      `[wired] stopping room=${record.roomId} port=${record.port} reason=${reason}`,
    );

    if (!record.process) {
      record.state = 'stopped';
      this.releasePort(record);
      record.log.close();
      record.resolveExit();
      return;
    }

    try {
      record.process.stdin?.write('shutdown\n');
    } catch (error) {
      this.appendLog(
        record,
        `[wired] failed to send shutdown command: ${this.errorMessage(error)}`,
      );
    }

    const exitedGracefully = await this.waitForExit(
      record,
      config.shutdownGraceMs,
    );
    if (exitedGracefully) {
      return;
    }

    record.forceKilled = true;
    this.appendLog(
      record,
      `[wired] graceful shutdown timed out after ${config.shutdownGraceMs}ms; forcing room=${record.roomId} port=${record.port}`,
    );
    this.logger.warn(
      `Forcing shutdown of room ${record.roomId} on port ${record.port} after ${config.shutdownGraceMs}ms grace period`,
    );
    try {
      record.process.kill();
    } catch (error) {
      this.appendLog(
        record,
        `[wired] force kill failed: ${this.errorMessage(error)}`,
      );
    }

    const exitedAfterKill = await this.waitForExit(record, FORCE_KILL_WAIT_MS);
    if (!exitedAfterKill) {
      record.state = 'failed';
      record.error = `Godot runtime did not exit within ${FORCE_KILL_WAIT_MS}ms after force kill`;
      record.stoppedAt = new Date().toISOString();
      // The process may still be alive and bound to its port. Keep the port
      // reserved and the log open; the real exit callback finalizes the record.
      // A new runtime for the same room will therefore use another free port.
      this.appendLog(record, `[wired] ${record.error}`);
    }
  }

  private waitForExit(
    record: RuntimeRecord,
    timeoutMs: number,
  ): Promise<boolean> {
    if (record.exitHandled) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void record.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // --- bookkeeping --------------------------------------------------------

  private releasePort(record: RuntimeRecord): void {
    this.registry.releasePort(record);
  }

  private clearTimers(record: RuntimeRecord): void {
    this.clearStartTimer(record);
    this.clearIdleTimer(record);
  }

  private clearStartTimer(record: RuntimeRecord): void {
    if (record.startTimer) {
      clearTimeout(record.startTimer);
      record.startTimer = undefined;
    }
  }

  private clearIdleTimer(record: RuntimeRecord): void {
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }
  }

  private resolveReady(record: RuntimeRecord): void {
    if (record.readySettled) {
      return;
    }
    record.readySettled = true;
    record.resolveReady();
  }

  private rejectReady(record: RuntimeRecord, error: Error): void {
    if (record.readySettled) {
      return;
    }
    record.readySettled = true;
    record.rejectReady(error);
  }

  private toInfo(record: RuntimeRecord): RoomRuntimeInfo {
    return {
      key: record.key,
      roomId: record.roomId,
      port: record.port,
      pid: record.pid,
      state: record.state,
      endpoint: this.runtimeConfiguration.buildEndpoint(
        this.configService.godotRuntime,
        record.roomId,
        record.port,
      ),
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt,
      activePlayers: record.activePlayers,
      exitCode: record.exitCode,
      error: record.error,
    };
  }

  private appendLog(record: RuntimeRecord, line: string): void {
    record.log.append(line);
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private errorMessage(error: unknown): string {
    return this.toError(error).message;
  }
}
