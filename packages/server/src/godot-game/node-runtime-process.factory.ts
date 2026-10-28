import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  RuntimeProcess,
  RuntimeProcessFactory,
  RuntimeSpawnOptions,
} from './room-runtime.types';

@Injectable()
export class NodeRuntimeProcessFactory extends RuntimeProcessFactory {
  spawn(options: RuntimeSpawnOptions): RuntimeProcess {
    const child = spawn(options.executablePath, options.args, {
      cwd: options.cwd,
      env: options.env,
      // stdin is used as the graceful shutdown control channel, stdout/stderr
      // carry the readiness and presence markers parsed by the lifecycle.
      stdio: ['pipe', 'pipe', 'pipe'],
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
