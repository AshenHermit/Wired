import { spawn, type ChildProcess } from 'node:child_process';

export type BakeRunnerOptions = {
  projectDir: string;
  jobsPath: string;
  timeoutMs: number;
};

export type BakeRunnerResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface BakeRunner {
  run(options: BakeRunnerOptions): Promise<BakeRunnerResult>;
}

const BAKE_SCRIPT = 'res://wired_bake.gd';

/** Runs the bake tool in a headless Godot process. */
export class ChildProcessBakeRunner implements BakeRunner {
  constructor(private readonly executablePath: string) {}

  run(options: BakeRunnerOptions): Promise<BakeRunnerResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.executablePath,
        ['--headless', '--path', options.projectDir, '--script', BAKE_SCRIPT, '--', options.jobsPath],
        {
          cwd: options.projectDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: BakeRunnerResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        killTree(child);
        if (!settled) {
          settled = true;
          reject(new Error('bake process timeout'));
        }
      }, options.timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        finish({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  child.kill('SIGKILL');
}
