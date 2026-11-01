import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import execa from 'execa';
import {
  NodeRuntimeProcessFactory,
  ProcessGroupWatchdog,
  processGroup,
} from './node-runtime-process.factory';
import { RuntimeSpawnOptions } from './room-runtime.types';

jest.mock('execa', () => jest.fn());

const mockedExeca = execa as unknown as jest.Mock;

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  constructor(readonly pid: number) {
    super();
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/**
 * The watchdog only needs a signal source and a kill sink, so the tests use a
 * plain emitter instead of the real process or a real Godot process.
 */
class FakeParent extends EventEmitter {
  pid = 999;
  readonly killed: Array<[number, NodeJS.Signals]> = [];
  readonly raised: NodeJS.Signals[] = [];

  kill = (pid: number, signal: NodeJS.Signals): boolean => {
    this.killed.push([pid, signal]);
    this.raised.push(signal);
    return true;
  };

  readonly groupKills: Array<[number, NodeJS.Signals]> = [];
  readonly killer = (pid: number, signal: NodeJS.Signals): void => {
    this.groupKills.push([pid, signal]);
  };
}

const spawnOptions: RuntimeSpawnOptions = {
  executablePath: 'C:/godot/godot.console.exe',
  args: ['--headless'],
  cwd: 'C:/wired/godot_project/_wired',
  env: { WIRED_GAME_TICKET_SECRET: 'test-secret' },
};

describe('NodeRuntimeProcessFactory', () => {
  let factory: NodeRuntimeProcessFactory;
  let children: FakeChildProcess[];

  beforeEach(() => {
    children = [];
    mockedExeca.mockReset();
    mockedExeca.mockImplementation((_path: string, _args: string[]) => {
      const child = new FakeChildProcess(4_242);
      children.push(child);
      return child;
    });
    factory = new NodeRuntimeProcessFactory();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('spawns the runtime in its own process group', () => {
    factory.spawn(spawnOptions);

    expect(mockedExeca).toHaveBeenCalledWith(
      spawnOptions.executablePath,
      spawnOptions.args,
      expect.objectContaining({
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        reject: false,
      }),
    );
  });

  it('kills the whole process tree on kill, not only the leader', () => {
    const killGroup = jest
      .spyOn(processGroup, 'kill')
      .mockImplementation(() => undefined);
    const runtime = factory.spawn(spawnOptions);

    runtime.kill('SIGKILL');

    expect(killGroup).toHaveBeenCalledWith(4_242, 'SIGKILL');
  });

  it('repeats a kill even when the child already counted as killed', () => {
    const killGroup = jest
      .spyOn(processGroup, 'kill')
      .mockImplementation(() => undefined);
    const runtime = factory.spawn(spawnOptions);
    children[0].killed = true;

    runtime.kill();

    expect(killGroup).toHaveBeenCalledWith(4_242, 'SIGTERM');
  });

  it('exposes the child streams and exit callback', () => {
    const runtime = factory.spawn(spawnOptions);
    const exit = jest.fn();

    runtime.onExit(exit);
    children[0].emit('exit', 0, null);

    expect(runtime.pid).toBe(4_242);
    expect(runtime.stdin).toBe(children[0].stdin);
    expect(runtime.stdout).toBe(children[0].stdout);
    expect(exit).toHaveBeenCalledWith(0, null);
  });
});

describe('ProcessGroupWatchdog', () => {
  let parent: FakeParent;
  let watchdog: ProcessGroupWatchdog;

  beforeEach(() => {
    parent = new FakeParent();
    watchdog = new ProcessGroupWatchdog(
      parent as unknown as NodeJS.Process,
      parent.killer,
    );
  });

  afterEach(() => {
    watchdog.dispose();
  });

  it('installs parent-death handlers once, not once per runtime', () => {
    watchdog.track(1);
    watchdog.track(2);
    watchdog.track(3);

    expect(parent.listenerCount('SIGTERM')).toBe(1);
    expect(parent.listenerCount('SIGINT')).toBe(1);
    expect(parent.listenerCount('exit')).toBe(1);
  });

  it('untracks an exited runtime and removes its listeners', () => {
    watchdog.track(1);
    watchdog.untrack(1);

    expect(parent.listenerCount('SIGTERM')).toBe(0);
    expect(parent.listenerCount('SIGINT')).toBe(0);
    expect(parent.listenerCount('exit')).toBe(0);
  });

  it('kills every tracked group when the parent receives SIGTERM', () => {
    watchdog.track(1);
    watchdog.track(2);

    parent.emit('SIGTERM');

    expect(parent.groupKills).toEqual([
      [1, 'SIGTERM'],
      [2, 'SIGTERM'],
    ]);
  });

  it('kills every tracked group when the parent receives SIGINT', () => {
    watchdog.track(7);

    parent.emit('SIGINT');

    expect(parent.groupKills).toEqual([[7, 'SIGTERM']]);
  });

  it('force kills leftovers when the parent exits', () => {
    watchdog.track(1);
    parent.emit('exit');

    expect(parent.groupKills).toEqual([[1, 'SIGKILL']]);
  });

  it('does not swallow a signal that another listener still handles', () => {
    watchdog.track(1);
    parent.on('SIGTERM', () => undefined);

    parent.emit('SIGTERM');

    // Nest's shutdown hooks re-raise the signal after a graceful close.
    expect(parent.raised).toEqual([]);
  });

  it('restores the default action when it was the only listener', () => {
    watchdog.track(1);

    parent.emit('SIGTERM');

    expect(parent.raised).toEqual(['SIGTERM']);
  });

  it('survives a group that is already gone', () => {
    const throwing = new ProcessGroupWatchdog(
      parent as unknown as NodeJS.Process,
      () => {
        throw new Error('ESRCH');
      },
    );

    expect(() => {
      throwing.track(1);
      parent.emit('SIGTERM');
    }).not.toThrow();
    throwing.dispose();
  });
});
