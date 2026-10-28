import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from 'src/config/config.service';
import { GameTicketService } from './game-ticket.service';
import { NodeRuntimeProcessFactory } from './node-runtime-process.factory';
import { RoomRuntimeService } from './room-runtime.service';
import { GodotRuntimeConfig } from './room-runtime.types';

/**
 * Opt-in end-to-end verification against the real Windows Godot runtime.
 * Run with:
 *   WIRED_GODOT_INTEGRATION=1 GODOT_RUNTIME_PATH=<...console.exe> \
 *     pnpm --filter server exec jest room-runtime.integration --runInBand
 */
const integrationEnabled = process.env.WIRED_GODOT_INTEGRATION === '1';
const runtimePath = process.env.GODOT_RUNTIME_PATH ?? '';
const projectPath = join(process.cwd(), 'godot_project', '_wired');
const canRun = integrationEnabled && runtimePath.length > 0;

const describeIntegration = canRun ? describe : describe.skip;

const waitFor = async (
  predicate: () => boolean,
  label: string,
  timeoutMs: number,
): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

describeIntegration('RoomRuntimeService with real Godot', () => {
  const roomId = 'integration-room';
  const port = 19250;
  const secret = 'integration-secret';
  let stateDir: string;
  let service: RoomRuntimeService;
  let client: ChildProcess | null = null;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'wired-godot-integration-'));
    const config: GodotRuntimeConfig = {
      executablePath: runtimePath,
      projectPath,
      portStart: port,
      portEnd: port,
      bindAddress: '127.0.0.1',
      idleTimeoutMs: 2_000,
      shutdownGraceMs: 8_000,
      startTimeoutMs: 20_000,
      ticketTtlSec: 60,
      ticketSecret: secret,
      stateDir,
      publicWsBaseUrl: '',
      logBufferLines: 2_000,
    };
    const configService = {
      godotRuntime: config,
      isProduction: false,
    } as unknown as AppConfigService;
    service = new RoomRuntimeService(
      configService,
      new NodeRuntimeProcessFactory(),
      new GameTicketService(configService),
    );
  });

  afterEach(async () => {
    if (client && client.exitCode === null) {
      client.kill();
    }
    client = null;
    await service.shutdownAll();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('shares one process, saves state on idle, and restarts for the next join', async () => {
    const [first, second] = await Promise.all([
      service.getConnection(roomId),
      service.getConnection(roomId),
    ]);
    expect(first.pid).toBe(second.pid);
    expect(first.port).toBe(port);
    expect(service.listRuntimes()).toHaveLength(1);

    client = spawn(
      runtimePath,
      [
        '--headless',
        '--path',
        projectPath,
        '--url',
        first.endpoint,
        '--ticket',
        first.ticket,
        '--room',
        roomId,
      ],
      { cwd: projectPath, windowsHide: true },
    );
    let clientOutput = '';
    client.stdout?.on('data', (chunk: Buffer) => {
      clientOutput += chunk.toString();
    });
    client.stderr?.on('data', (chunk: Buffer) => {
      clientOutput += chunk.toString();
    });

    await waitFor(
      () => clientOutput.includes('WIRED_CLIENT_AUTH_OK'),
      'client authentication',
      20_000,
    );
    await waitFor(
      () =>
        service.getLogs(roomId).some((line) => line.includes('WIRED_AUTH_OK')),
      'server auth marker',
      10_000,
    );

    client.kill();
    client = null;

    await waitFor(
      () => service.getRuntime(roomId)?.state === 'stopped',
      'idle stop',
      30_000,
    );

    const statePath = join(stateDir, roomId, 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      room: string;
      port: number;
      reason: string;
    };
    expect(saved.room).toBe(roomId);
    expect(saved.port).toBe(port);
    expect(saved.reason).toBe('shutdown_command');

    const logs = service.getLogs(roomId).join('\n');
    expect(logs).toContain('WIRED_STATE_SAVED');
    expect(logs).not.toContain('forcing');

    const restarted = await service.getConnection(roomId);
    expect(restarted.state).toBe('running');
    expect(restarted.port).toBe(port);
    expect(restarted.pid).not.toBeNull();

    await service.stopRoom(roomId, 'test_done');
    expect(service.getRuntime(roomId)?.state).toBe('stopped');
  }, 120_000);
});
