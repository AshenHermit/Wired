import { Injectable } from '@nestjs/common';
import execa from 'execa';
import {
  RuntimeProcess,
  RuntimeProcessFactory,
  RuntimeSpawnOptions,
} from './room-runtime.types';

/**
 * Spawns the Godot runtime through execa.
 *
 * execa owns the platform differences of starting a child process and of
 * killing it (including Windows), while this adapter exposes only the narrow
 * surface the runtime session needs. `reject: false` is important: the
 * process runs for hours and exits with a non-zero code on failure, which
 * must be handled by the session's exit callback rather than by an
 * unobserved rejected promise.
 */
@Injectable()
export class NodeRuntimeProcessFactory extends RuntimeProcessFactory {
  spawn(options: RuntimeSpawnOptions): RuntimeProcess {
    const child = execa(options.executablePath, options.args, {
      cwd: options.cwd,
      env: options.env,
      // stdin is the graceful shutdown channel; stdout/stderr carry the
      // readiness and presence markers parsed by the session.
      stdio: ['pipe', 'pipe', 'pipe'],
      // Room runtimes are long-lived; do not accumulate their output in memory.
      buffer: false,
      reject: false,
      windowsHide: true,
    });

    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (callback) => {
        child.once('exit', callback);
      },
      onError: (callback) => {
        child.once('error', callback);
      },
      kill: (signal) => {
        if (!child.killed) {
          child.kill(signal);
        }
      },
    };
  }
}
