import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createWriteStream, mkdirSync, WriteStream } from 'node:fs';
import { join } from 'node:path';
import { AppConfigService } from 'src/config/config.service';
import { GameTicketService } from './game-ticket.service';
import { RoomRuntimeError } from './room-runtime.errors';
import {
  GodotRuntimeConfig,
  RoomConnection,
  RoomRuntimeInfo,
  RoomRuntimeState,
  RuntimeProcess,
  RuntimeProcessFactory,
} from './room-runtime.types';

const READY_PATTERN = /^WIRED_SERVER_READY room=(\S+) port=(\d+) bind=(\S+)/;
const AUTH_OK_PATTERN = /^WIRED_AUTH_OK peer=\d+ player=\d+ room=(\S+)/;
const PLAYER_LEFT_PATTERN = /^WIRED_PLAYER_LEFT peer=\d+ player=\d+/;
const FORCE_KILL_WAIT_MS = 2_000;

interface RuntimeRecord {
  key: string;
  roomId: string;
  port: number;
  state: RoomRuntimeState;
  process: RuntimeProcess | null;
  pid: number | null;
  logs: string[];
  logStream: WriteStream | null;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  error: string | null;
  activePlayers: number;
  stopRequested: boolean;
  forceKilled: boolean;
  readySettled: boolean;
  exitHandled: boolean;
  portReleased: boolean;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  startTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  stopPromise?: Promise<void>;
}

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
  private readonly activeByRoom = new Map<string, RuntimeRecord>();
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly reservedPorts = new Map<number, RuntimeRecord>();

  constructor(
    private readonly configService: AppConfigService,
    private readonly processFactory: RuntimeProcessFactory,
    private readonly tickets: GameTicketService,
  ) {}

  /**
   * Returns a ready runtime for the room, starting the process if needed.
   * Rejects with an explicit lifecycle error when the room cannot start; it
   * never falls back to a "maybe works" endpoint.
   */
  async getConnection(roomId: string): Promise<RoomConnection> {
    const record = this.ensureRuntime(roomId);
    await record.readyPromise;

    if (record.state !== 'running') {
      throw new RoomRuntimeError(
        'start_failed',
        record.error ?? `Room ${roomId} is not running`,
        roomId,
        record.port,
      );
    }

    const ticket = this.tickets.mint(roomId);
    return {
      ...this.toInfo(record),
      ticket: ticket.ticket,
      ticketExpiresAt: ticket.expiresAt,
    };
  }

  /** Current runtime status; never starts a process. */
  getRuntime(roomId: string): RoomRuntimeInfo | null {
    const record = this.activeByRoom.get(roomId);
    return record ? this.toInfo(record) : null;
  }

  listRuntimes(): RoomRuntimeInfo[] {
    return [...this.activeByRoom.values()].map((record) => this.toInfo(record));
  }

  getLogs(roomId: string): string[] {
    return [...(this.activeByRoom.get(roomId)?.logs ?? [])];
  }

  /**
   * Graceful stop: ask Godot to save state and exit over stdin, then force
   * kill only after the configured grace period.
   */
  stopRoom(roomId: string, reason = 'requested'): Promise<void> {
    const record = this.activeByRoom.get(roomId);
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
    const records = [...this.activeByRoom.values()].filter(
      (record) => record.state === 'starting' || record.state === 'running',
    );
    await Promise.all(
      records.map((record) =>
        this.stopRoom(record.roomId, 'backend_shutdown').catch((error) => {
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
    const config = this.configService.godotRuntime;
    this.validateConfig(config);

    const existing = this.activeByRoom.get(roomId);
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

    const port = this.allocatePort(config);
    if (port === null) {
      throw new RoomRuntimeError(
        'start_failed',
        `No free port in range ${config.portStart}-${config.portEnd}`,
        roomId,
      );
    }

    const record = this.createRecord(roomId, port);
    this.activeByRoom.set(roomId, record);
    this.records.set(record.key, record);
    this.reservedPorts.set(port, record);
    this.openLog(record, config);
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
      const child = this.processFactory.spawn({
        executablePath: config.executablePath,
        args: [
          '--headless',
          '--path',
          config.projectPath,
          '--server',
          '--port',
          String(port),
          '--room',
          roomId,
          '--bind',
          config.bindAddress,
          // The Godot project saves room state here before exiting.
          '--state-dir',
          join(config.stateDir, this.safeName(roomId)),
        ],
        cwd: config.projectPath,
        env: {
          ...process.env,
          WIRED_GAME_TICKET_SECRET: config.ticketSecret,
        },
      });
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
      key: `${roomId}:${port}`,
      roomId,
      port,
      state: 'starting',
      process: null,
      pid: null,
      logs: [],
      logStream: null,
      startedAt: null,
      stoppedAt: null,
      exitCode: null,
      exitSignal: null,
      error: null,
      activePlayers: 0,
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

  private validateConfig(config: GodotRuntimeConfig): void {
    if (!config.executablePath || !config.projectPath) {
      throw new RoomRuntimeError(
        'config',
        'GODOT_RUNTIME_PATH and GODOT_RUNTIME_PROJECT_PATH must be configured',
      );
    }
    if (
      !Number.isInteger(config.portStart) ||
      !Number.isInteger(config.portEnd) ||
      config.portStart < 1 ||
      config.portEnd > 65_535 ||
      config.portStart > config.portEnd
    ) {
      throw new RoomRuntimeError(
        'config',
        `Invalid Godot room port range ${config.portStart}-${config.portEnd}`,
      );
    }
    if (!config.ticketSecret) {
      throw new RoomRuntimeError(
        'ticket_secret_missing',
        'WIRED_GAME_TICKET_SECRET is not configured; the Godot room server cannot verify game tickets',
      );
    }
    if (this.configService.isProduction && !config.publicWsBaseUrl) {
      throw new RoomRuntimeError(
        'config',
        'GODOT_ROOM_PUBLIC_WS_BASE is required in production; clients must not receive internal ports',
      );
    }
  }

  private allocatePort(config: GodotRuntimeConfig): number | null {
    for (let port = config.portStart; port <= config.portEnd; port += 1) {
      if (!this.reservedPorts.has(port)) {
        return port;
      }
    }
    return null;
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

    const ready = READY_PATTERN.exec(line);
    if (ready) {
      this.handleReady(record, ready[1], Number(ready[2]));
      return;
    }

    const authOk = AUTH_OK_PATTERN.exec(line);
    if (authOk) {
      record.activePlayers += 1;
      this.clearIdleTimer(record);
      return;
    }

    if (PLAYER_LEFT_PATTERN.test(line)) {
      record.activePlayers = Math.max(0, record.activePlayers - 1);
      if (record.activePlayers === 0) {
        this.scheduleIdleStop(record);
      }
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
    this.closeLog(record);
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
    this.closeLog(record);
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
    this.releasePort(record);
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
    this.appendLog(
      record,
      `[wired] no authenticated players; idle stop scheduled in ${config.idleTimeoutMs}ms`,
    );
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.state !== 'running' || record.activePlayers > 0) {
        return;
      }
      void this.stopRoom(record.roomId, 'idle_timeout').catch((error) => {
        this.logger.warn(
          `Idle stop failed for room ${record.roomId}: ${this.errorMessage(error)}`,
        );
      });
    }, config.idleTimeoutMs);
    record.idleTimer.unref?.();
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
      this.closeLog(record);
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
      this.releasePort(record);
      this.appendLog(record, `[wired] ${record.error}`);
      this.closeLog(record);
      record.resolveExit();
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
    if (record.portReleased) {
      return;
    }
    record.portReleased = true;
    if (this.reservedPorts.get(record.port) === record) {
      this.reservedPorts.delete(record.port);
    }
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
      endpoint: this.buildEndpoint(record),
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt,
      activePlayers: record.activePlayers,
      exitCode: record.exitCode,
      error: record.error,
    };
  }

  private buildEndpoint(record: RuntimeRecord): string {
    const config = this.configService.godotRuntime;
    const template = config.publicWsBaseUrl;
    if (template) {
      return template
        .split('{room}')
        .join(encodeURIComponent(record.roomId))
        .split('{port}')
        .join(String(record.port));
    }
    return `ws://${this.localHost(config)}:${record.port}`;
  }

  private localHost(config: GodotRuntimeConfig): string {
    if (!config.bindAddress || config.bindAddress === '0.0.0.0') {
      return '127.0.0.1';
    }
    return config.bindAddress;
  }

  // --- logs ---------------------------------------------------------------

  private openLog(record: RuntimeRecord, config: GodotRuntimeConfig): void {
    try {
      mkdirSync(config.stateDir, { recursive: true });
      const path = join(
        config.stateDir,
        `${this.safeName(record.roomId)}-${record.port}.log`,
      );
      record.logStream = createWriteStream(path, { flags: 'a' });
      record.logStream.on('error', (error) => {
        this.logger.warn(
          `Cannot write runtime log for room ${record.roomId}: ${error.message}`,
        );
      });
      record.logStream.write(
        `[wired] session key=${record.key} started_at=${new Date().toISOString()}\n`,
      );
    } catch (error) {
      this.logger.warn(
        `Cannot open runtime log for room ${record.roomId}: ${this.errorMessage(error)}`,
      );
    }
  }

  private appendLog(record: RuntimeRecord, line: string): void {
    record.logs.push(line);
    const limit = this.configService.godotRuntime.logBufferLines;
    if (limit > 0 && record.logs.length > limit) {
      record.logs.splice(0, record.logs.length - limit);
    }
    record.logStream?.write(`${line}\n`);
  }

  private closeLog(record: RuntimeRecord): void {
    const stream = record.logStream;
    if (!stream) {
      return;
    }
    record.logStream = null;
    stream.end();
  }

  private safeName(roomId: string): string {
    return roomId.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private errorMessage(error: unknown): string {
    return this.toError(error).message;
  }
}
