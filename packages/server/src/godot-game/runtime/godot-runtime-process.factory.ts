import { Injectable } from '@nestjs/common';
import { spawn, spawnSync } from 'node:child_process';
import {
  RuntimeProcess,
  RuntimeProcessFactory,
  RuntimeSpawnOptions,
} from './room-runtime.types';

/** Parent-death signals that still run JavaScript before the exit. */
const PARENT_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

export type GroupKiller = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Sends a signal to the process tree led by `pid`.
 *
 * The runtime is spawned detached, so on POSIX it leads its own process group
 * and `kill(-pid)` reaches Godot and any helper process it started. Windows
 * has no process groups in that sense, so the tree is terminated through
 * `taskkill /T`.
 */
export const processGroup = {
  kill: (pid: number, signal: NodeJS.Signals): void => {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      // The group leader is already gone; try the bare pid once.
      try {
        process.kill(pid, signal);
      } catch {
        // Nothing left to kill.
      }
    }
  },
};

const killGroup: GroupKiller = (pid, signal) => processGroup.kill(pid, signal);

/**
 * Best-effort kill-on-parent-death for detached runtime processes.
 *
 * A graceful stop already writes `shutdown` to Godot and waits for it, so this
 * watchdog only covers the paths where the backend cannot run its shutdown
 * hooks: SIGTERM/SIGINT (Docker stop, Ctrl+C) and the final `exit`. Handlers
 * are installed once for the whole backend, so a hundred rooms add three
 * listeners, not three hundred.
 *
 * Nothing here survives `SIGKILL`; that case is bounded by the port quarantine
 * of the registry, which steers the next start away from an occupied port.
 */
export class ProcessGroupWatchdog {
  private readonly pids = new Set<number>();
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();
  private exitHandler?: () => void;

  constructor(
    private readonly target: NodeJS.Process = process,
    private readonly killer: GroupKiller = killGroup,
  ) {}

  track(pid: number | undefined): void {
    if (pid === undefined) {
      return;
    }
    this.pids.add(pid);
    if (this.exitHandler) {
      return;
    }
    for (const signal of PARENT_SIGNALS) {
      const handler = () => this.handleSignal(signal);
      this.signalHandlers.set(signal, handler);
      this.target.on(signal, handler);
    }
    this.exitHandler = () => this.handleExit();
    this.target.on('exit', this.exitHandler);
  }

  untrack(pid: number | undefined): void {
    if (pid === undefined) {
      return;
    }
    this.pids.delete(pid);
    if (this.pids.size === 0) {
      this.uninstall();
    }
  }

  /** Synchronous best-effort kill of one group. */
  kill(pid: number, signal: NodeJS.Signals): void {
    try {
      this.killer(pid, signal);
    } catch {
      // A group that is already gone is the expected case here.
    }
  }

  /** Synchronous best-effort kill of every tracked group. */
  killAll(signal: NodeJS.Signals): void {
    for (const pid of [...this.pids]) {
      this.kill(pid, signal);
    }
  }

  dispose(): void {
    this.pids.clear();
    this.uninstall();
  }

  private handleSignal(signal: NodeJS.Signals): void {
    // Someone else runs the graceful path. Nest's shutdown hooks are the
    // important case: they await onModuleDestroy, which writes `shutdown` to
    // every runtime so Godot can persist `state.json` before exiting. Killing
    // the groups here would preempt that save.
    if (this.target.listenerCount(signal) > 1) {
      return;
    }
    // The backend is going down with no graceful shutdown available: take its
    // Godot processes with it instead of leaving them bound to the room ports
    // until the next deployment.
    this.killAll('SIGTERM');
    this.uninstall();
    // A registered signal listener disables the default "terminate" action.
    // Restore it; no other listener is left to do it.
    this.target.kill(this.target.pid, signal);
  }

  private handleExit(): void {
    // Last chance: the parent is exiting and nothing else will clean up.
    this.killAll('SIGKILL');
    this.pids.clear();
  }

  private uninstall(): void {
    for (const [signal, handler] of this.signalHandlers) {
      this.target.removeListener(signal, handler);
    }
    this.signalHandlers.clear();
    if (this.exitHandler) {
      this.target.removeListener('exit', this.exitHandler);
      this.exitHandler = undefined;
    }
  }
}

/**
 * Spawns the Godot runtime as a detached child process.
 *
 * `node:child_process` is all that is needed here: the output has to be streamed
 * rather than buffered, a non-zero exit is handled by the session's exit
 * callback rather than by a rejected promise, and killing goes through
 * `ProcessGroupWatchdog` so the whole Godot tree dies. A wrapper library only
 * adds a dependency for behaviour that is deliberately unused.
 *
 * `detached: true` gives the runtime its own process group, so one kill
 * reaches the whole Godot tree and the process no longer dies (or survives)
 * together with the backend's signal group by accident.
 */
@Injectable()
export class GodotRuntimeProcessFactory extends RuntimeProcessFactory {
  private readonly watchdog = new ProcessGroupWatchdog();

  spawn(options: RuntimeSpawnOptions): RuntimeProcess {
    const child = spawn(options.executablePath, options.args, {
      cwd: options.cwd,
      env: options.env,
      // stdin is the graceful shutdown channel; stdout/stderr carry the
      // readiness and presence markers parsed by the session.
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, see the class comment.
      detached: true,
      windowsHide: true,
    });

    const pid = typeof child.pid === 'number' ? child.pid : undefined;
    this.watchdog.track(pid);
    void child.once('exit', () => this.watchdog.untrack(pid));

    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (callback) => {
        void child.once('exit', callback);
      },
      onError: (callback) => {
        void child.once('error', callback);
      },
      kill: (signal) => {
        if (pid === undefined) {
          child.kill(signal);
          return;
        }
        // Always retry: a child that survived an earlier kill must get
        // another one instead of being skipped as "already killed".
        this.watchdog.kill(pid, signal ?? 'SIGTERM');
      },
    };
  }
}
