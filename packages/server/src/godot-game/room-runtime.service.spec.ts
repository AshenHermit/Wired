import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from 'src/config/config.service';
import { RoomRuntimeError } from './room-runtime.errors';
import { RoomRuntimeService } from './room-runtime.service';
import {
  GodotRuntimeConfig,
  RuntimeProcess,
  RuntimeProcessFactory,
} from './room-runtime.types';
import { GameTicketService } from './game-ticket.service';

class FakeRuntimeProcess implements RuntimeProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  killed = false;
  killSignal: NodeJS.Signals | undefined;
  private exitCallback?: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;

  constructor(readonly pid: number) {
    this.stdin.on('data', (chunk: Buffer) =>
      this.written.push(chunk.toString()),
    );
  }

  onExit(
    callback: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.exitCallback = callback;
  }

  onError(): void {
    // Spawn errors are simulated by throwing from the factory.
  }

  kill(signal?: NodeJS.Signals): void {
    this.killed = true;
    this.killSignal = signal;
    this.exit(1, 'SIGKILL');
  }

  emitLine(line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this[stream].write(`${line}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCallback?.(code, signal);
  }

  get stdinText(): string {
    return this.written.join('');
  }
}

class FakeRuntimeProcessFactory implements RuntimeProcessFactory {
  readonly processes: FakeRuntimeProcess[] = [];

  spawn(): RuntimeProcess {
    const process = new FakeRuntimeProcess(1000 + this.processes.length);
    this.processes.push(process);
    return process;
  }

  get last(): FakeRuntimeProcess {
    const process = this.processes.at(-1);
    if (!process) {
      throw new Error('No runtime process was spawned');
    }
    return process;
  }
}

const flushAsync = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

describe('RoomRuntimeService', () => {
  let stateDir: string;
  let factory: FakeRuntimeProcessFactory;
  let config: GodotRuntimeConfig;
  let service: RoomRuntimeService;

  const createService = (
    overrides: Partial<GodotRuntimeConfig> = {},
    isProduction = false,
  ) => {
    config = {
      executablePath: 'C:/godot/godot.console.exe',
      projectPath: 'C:/wired/godot_project/_wired',
      portStart: 19100,
      portEnd: 19102,
      bindAddress: '127.0.0.1',
      idleTimeoutMs: 60_000,
      shutdownGraceMs: 5_000,
      startTimeoutMs: 10_000,
      ticketTtlSec: 60,
      ticketSecret: 'test-secret',
      stateDir,
      publicWsBaseUrl: '',
      logBufferLines: 50,
      ...overrides,
    };
    const configService = {
      godotRuntime: config,
      isProduction,
    } as unknown as AppConfigService;
    const tickets = new GameTicketService(configService);
    return new RoomRuntimeService(configService, factory, tickets);
  };

  const startRoom = async (roomId: string) => {
    const connection = service.getConnection(roomId);
    await flushAsync();
    const process = factory.last;
    process.emitLine(
      `WIRED_SERVER_READY room=${roomId} port=${connectionPort(process)} bind=127.0.0.1`,
    );
    return { connection: await connection, process };
  };

  const connectionPort = (process: FakeRuntimeProcess): number =>
    19100 + factory.processes.indexOf(process);

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'wired-runtime-'));
    factory = new FakeRuntimeProcessFactory();
    service = createService();
  });

  afterEach(async () => {
    jest.useRealTimers();
    for (const process of factory.processes) {
      process.exit(0);
    }
    await service.shutdownAll();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('spawns exactly one runtime for concurrent requests to an idle room', async () => {
    const first = service.getConnection('room-1');
    const second = service.getConnection('room-1');
    await flushAsync();

    expect(factory.processes).toHaveLength(1);
    factory.last.emitLine(
      'WIRED_SERVER_READY room=room-1 port=19100 bind=127.0.0.1',
    );

    const [a, b] = await Promise.all([first, second]);
    expect(a.port).toBe(19100);
    expect(b.port).toBe(19100);
    expect(a.pid).toBe(b.pid);
    expect(a.ticket).not.toBe(b.ticket);
    expect(service.getRuntime('room-1')?.state).toBe('running');
  });

  it('reports starting until the ready line arrives and uses distinct ports per room', async () => {
    const first = service.getConnection('room-1');
    await flushAsync();
    expect(service.getRuntime('room-1')?.state).toBe('starting');
    factory.processes[0].emitLine(
      'WIRED_SERVER_READY room=room-1 port=19100 bind=127.0.0.1',
    );
    await first;

    const second = service.getConnection('room-2');
    await flushAsync();
    factory.processes[1].emitLine(
      'WIRED_SERVER_READY room=room-2 port=19101 bind=127.0.0.1',
    );

    expect((await second).port).toBe(19101);
    expect(factory.processes).toHaveLength(2);
  });

  it('fails explicitly when WIRED_GAME_TICKET_SECRET is not configured', async () => {
    service = createService({ ticketSecret: '' });

    await expect(service.getConnection('room-1')).rejects.toMatchObject({
      code: 'ticket_secret_missing',
    });
    expect(factory.processes).toHaveLength(0);
  });

  it('maps exit code 2 to an explicit start failure and releases the port', async () => {
    const connection = service.getConnection('room-1');
    await flushAsync();
    factory.last.exit(2);

    await expect(connection).rejects.toThrow(/WIRED_GAME_TICKET_SECRET/);
    expect(service.getRuntime('room-1')?.state).toBe('failed');

    const retry = service.getConnection('room-1');
    await flushAsync();
    expect(factory.processes).toHaveLength(2);
    expect(service.getRuntime('room-1')?.port).toBe(19100);
    factory.last.emitLine(
      'WIRED_SERVER_READY room=room-1 port=19100 bind=127.0.0.1',
    );
    await retry;
  });

  it('maps exit code 3 to an explicit port binding failure', async () => {
    const connection = service.getConnection('room-1');
    await flushAsync();
    factory.last.exit(3);

    await expect(connection).rejects.toThrow(/port 19100/);
    expect(service.getRuntime('room-1')?.state).toBe('failed');
  });

  it('marks an unexpected exit as not running and restarts on the next request', async () => {
    const { process } = await startRoom('room-1');
    process.exit(1);

    expect(service.getRuntime('room-1')?.state).toBe('failed');
    expect(service.getRuntime('room-1')?.exitCode).toBe(1);

    const next = service.getConnection('room-1');
    await flushAsync();
    expect(factory.processes).toHaveLength(2);
    factory.last.emitLine(
      'WIRED_SERVER_READY room=room-1 port=19100 bind=127.0.0.1',
    );
    await expect(next).resolves.toMatchObject({ state: 'running' });
  });

  it('rejects a new connection while the room is stopping', async () => {
    await startRoom('room-1');
    const stopping = service.stopRoom('room-1');

    await expect(service.getConnection('room-1')).rejects.toMatchObject({
      code: 'room_stopping',
    });

    factory.last.exit(0);
    await stopping;
  });

  it('sends a graceful shutdown command and lets Godot exit on its own', async () => {
    const { process } = await startRoom('room-1');

    const stopping = service.stopRoom('room-1');
    await flushAsync();
    expect(process.stdinText).toContain('shutdown');
    expect(process.killed).toBe(false);

    process.exit(0);
    await stopping;

    expect(service.getRuntime('room-1')?.state).toBe('stopped');
    expect(process.killed).toBe(false);
  });

  it('force kills only after the grace period and logs it', async () => {
    jest.useFakeTimers();
    const { process } = await startRoom('room-1');

    const stopping = service.stopRoom('room-1');
    await flushAsync();
    expect(process.stdinText).toContain('shutdown');

    jest.advanceTimersByTime(config.shutdownGraceMs);
    await flushAsync();
    process.exit(0);
    await stopping;

    expect(process.killed).toBe(true);
    expect(service.getLogs('room-1').join('\n')).toMatch(/forc/i);
    expect(service.getRuntime('room-1')?.state).toBe('stopped');
  });

  it('starts the idle timer when the last player leaves and cancels it on rejoin', async () => {
    jest.useFakeTimers();
    const { process } = await startRoom('room-1');

    process.emitLine('WIRED_AUTH_OK peer=2 player=1 room=room-1');
    expect(service.getRuntime('room-1')?.activePlayers).toBe(1);

    process.emitLine('WIRED_PLAYER_LEFT peer=2 player=1');
    expect(service.getRuntime('room-1')?.activePlayers).toBe(0);

    jest.advanceTimersByTime(config.idleTimeoutMs - 1_000);
    process.emitLine('WIRED_AUTH_OK peer=3 player=2 room=room-1');

    jest.advanceTimersByTime(config.idleTimeoutMs + 1_000);
    await flushAsync();
    expect(service.getRuntime('room-1')?.state).toBe('running');
    expect(process.stdinText).toBe('');

    process.emitLine('WIRED_PLAYER_LEFT peer=3 player=2');
    jest.advanceTimersByTime(config.idleTimeoutMs);
    await flushAsync();
    expect(process.stdinText).toContain('shutdown');

    process.exit(0);
    await flushAsync();
    expect(service.getRuntime('room-1')?.state).toBe('stopped');
  });

  it('does not report an exited runtime as running', async () => {
    const { process } = await startRoom('room-1');
    process.exit(0);

    expect(service.getRuntime('room-1')).toMatchObject({
      state: 'stopped',
      exitCode: 0,
    });
  });

  it('keeps runtime logs and persists them to the state directory', async () => {
    const { process } = await startRoom('room-1');
    process.emitLine('WIRED_LOG hello from godot', 'stderr');

    expect(service.getLogs('room-1').join('\n')).toContain('hello from godot');
    expect(factory.processes).toHaveLength(1);
  });

  it('refuses to start when production has no public WebSocket endpoint', async () => {
    service = createService({ publicWsBaseUrl: '' }, true);

    await expect(service.getConnection('room-1')).rejects.toBeInstanceOf(
      RoomRuntimeError,
    );
    expect(factory.processes).toHaveLength(0);
  });

  it('returns the configured public WebSocket endpoint in production', async () => {
    service = createService(
      { publicWsBaseUrl: 'wss://games.example/godot/{room}?port={port}' },
      true,
    );

    const connection = service.getConnection('room-1');
    await flushAsync();
    factory.last.emitLine(
      'WIRED_SERVER_READY room=room-1 port=19100 bind=127.0.0.1',
    );

    await expect(connection).resolves.toMatchObject({
      endpoint: 'wss://games.example/godot/room-1?port=19100',
      port: 19100,
    });
  });

  it('fails the start when readiness never arrives', async () => {
    jest.useFakeTimers();
    const connection = service.getConnection('room-1');
    await flushAsync();

    jest.advanceTimersByTime(config.startTimeoutMs);
    await flushAsync();

    await expect(connection).rejects.toThrow(/WIRED_SERVER_READY/);
    expect(factory.last.killed).toBe(true);
    expect(service.getRuntime('room-1')?.state).toBe('failed');
  });

  it('rejects waiting callers when the room is stopped while starting', async () => {
    const connection = service.getConnection('room-1');
    await flushAsync();

    const stopping = service.stopRoom('room-1');
    await expect(connection).rejects.toMatchObject({ code: 'room_stopping' });

    factory.last.exit(0);
    await stopping;
    expect(service.getRuntime('room-1')?.state).toBe('stopped');
  });

  it('writes runtime logs to the per-room file', async () => {
    const { process } = await startRoom('room-1');
    process.emitLine('WIRED_LOG persisted line');
    process.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const logPath = join(stateDir, 'room-1-19100.log');
    expect(readFileSync(logPath, 'utf8')).toContain('persisted line');
  });
});
