import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ResolvedClosure } from '../publish/package-closure-resolver';
import type { PackageTextFile } from '../publish/package-runtime-references';
import type { AssetBakeCache } from './asset-bake-cache';
import { BAKED_SUFFIX, UNSUPPORTED_ASSET_EXTENSIONS } from './asset-bake.constants';
import { AssetBakeError, type BakeJob } from './asset-bake.types';
import type { BakeRunner } from './godot-bake.runner';

const GLB_EXTENSION = '.glb';
const IMPORT_EXTENSION = '.import';
const COMMENT_PREFIXES = ['#', ';'];
const BAKE_OK_PREFIX = 'WIRED_BAKE_OK ';
const BAKE_ERROR_PREFIX = 'WIRED_BAKE_ERROR ';
/** The runtime rejects a manifest entry above this size. */
const MAX_BAKED_FILE_SIZE = 67_108_864;
const TOOL_FILES = ['project.godot', 'bake_tool.gd', 'wired_bake.gd'];

/** `res://packages/<slug>/<file>` where the file is an importable 3D asset. */
const ASSET_REFERENCE_RE =
  /res:\/\/packages\/([^/"\s]+)\/([^"\s]+\.(?:glb|gltf|fbx|dae|obj|blend))/gi;

export type AssetBakeOptions = {
  /** Directory that holds `project.godot`, `bake_tool.gd` and `wired_bake.gd`. */
  projectPath: string;
  executablePath: string;
  timeoutMs: number;
  maxConcurrency: number;
};

/**
 * Decides which raw assets of a resolved closure have to be baked before the
 * runtime artifact is written, and bakes them through a headless Godot process.
 *
 * Only the root package's bytes are materialized by the closure, so a reference
 * to another package's asset cannot be baked: that is a build error instead of a
 * scene that points at a file the runtime cannot load.
 */
export class AssetBakeService {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly cache?: AssetBakeCache,
    private readonly runner?: BakeRunner,
    private readonly options?: AssetBakeOptions,
  ) {}

  planJobs(resolved: ResolvedClosure, slug: string): BakeJob[] {
    const unsupported = resolved.rootFiles
      .map((entry) => entry.filepath)
      .filter((filepath) => this.isUnsupported(filepath));
    if (unsupported.length > 0) {
      throw new AssetBakeError(
        'unsupported_asset_format',
        `unsupported_asset_format: ${unsupported.join(', ')}`,
      );
    }
    this.assertNoDependencyAssets(resolved, slug);
    return resolved.rootFiles
      .filter((entry) => entry.filepath.toLowerCase().endsWith(GLB_EXTENSION))
      .map((entry) => ({
        source: entry.filepath,
        output: `${entry.filepath}${BAKED_SUFFIX}`,
        preset: this.readPreset(resolved, entry.filepath),
      }));
  }

  /** Returns the baked scene bytes keyed by [BakeJob.output]. */
  async bake(
    resolved: ResolvedClosure,
    slug: string,
    jobs: BakeJob[],
  ): Promise<Map<string, Buffer>> {
    const { cache, runner, options } = this;
    if (cache === undefined || runner === undefined || options === undefined) {
      throw new AssetBakeError('bake_not_configured', 'asset bake pipeline is not configured');
    }
    const baked = new Map<string, Buffer>();
    if (jobs.length === 0) {
      return baked;
    }
    const keys = new Map<string, string>();
    const misses: BakeJob[] = [];
    for (const job of jobs) {
      const source = resolved.bytes.get(job.source);
      if (source === undefined) {
        throw new AssetBakeError('asset_missing', `asset_missing: ${job.source}`);
      }
      const key = cache.keyFor(source, job.preset);
      keys.set(job.output, key);
      const cached = cache.get(key);
      if (cached === null) {
        misses.push(job);
        continue;
      }
      baked.set(job.output, cached);
    }
    if (misses.length === 0) {
      return baked;
    }

    await this.acquire();
    let projectDir: string | null = null;
    try {
      projectDir = await mkdtemp(join(tmpdir(), 'wired-bake-'));
      await this.stageProject(projectDir, resolved, slug, options.projectPath);
      const jobsPath = join(projectDir, 'jobs.json');
      await writeFile(
        jobsPath,
        JSON.stringify({
          jobs: misses.map((job) => ({
            source: `packages/${slug}/${job.source}`,
            output: `packages/${slug}/${job.output}`,
            preset: job.preset ?? '',
          })),
        }),
        'utf8',
      );
      await this.runTool(runner, options.timeoutMs, projectDir, jobsPath);
      const produced = await this.readOutputs(projectDir, slug, misses);
      for (const [output, bytes] of produced) {
        baked.set(output, bytes);
        const key = keys.get(output);
        if (key !== undefined) {
          await cache.put(key, bytes);
        }
      }
      await cache.prune();
    } finally {
      if (projectDir !== null) {
        await rm(projectDir, { recursive: true, force: true });
      }
      this.release();
    }
    return baked;
  }

  private isUnsupported(filepath: string): boolean {
    const lower = filepath.toLowerCase();
    return UNSUPPORTED_ASSET_EXTENSIONS.some((extension) => lower.endsWith(extension));
  }

  /** The normalized sidecar travels in `bytes`; `.import` never reaches the artifact. */
  private readPreset(resolved: ResolvedClosure, filepath: string): string | null {
    const preset = resolved.bytes.get(`${filepath}${IMPORT_EXTENSION}`);
    return preset === undefined ? null : preset.toString('utf8');
  }

  private assertNoDependencyAssets(resolved: ResolvedClosure, slug: string): void {
    const texts: PackageTextFile[] = [...resolved.rootTextFiles];
    for (const files of resolved.dependencyTextFiles.values()) {
      texts.push(...files);
    }
    for (const file of texts) {
      for (const reference of this.assetReferences(file.text)) {
        if (reference.slug === slug) {
          continue;
        }
        throw new AssetBakeError(
          'dependency_asset_unsupported',
          `dependency_asset_unsupported: ${file.filepath} -> ${reference.slug}/${reference.filepath}`,
        );
      }
    }
  }

  private assetReferences(text: string): Array<{ slug: string; filepath: string }> {
    const body = text
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart();
        return !COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
      })
      .join('\n');
    const found: Array<{ slug: string; filepath: string }> = [];
    for (const match of body.matchAll(ASSET_REFERENCE_RE)) {
      found.push({ slug: match[1], filepath: match[2] });
    }
    return found;
  }

  /** Copies the bake tool and every resolved file into a throwaway project. */
  private async stageProject(
    projectDir: string,
    resolved: ResolvedClosure,
    slug: string,
    toolPath: string,
  ): Promise<void> {
    for (const name of TOOL_FILES) {
      await copyFile(join(toolPath, name), join(projectDir, name));
    }
    for (const [filepath, bytes] of resolved.bytes) {
      const target = join(projectDir, 'packages', slug, filepath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  }

  private async runTool(
    runner: BakeRunner,
    timeoutMs: number,
    projectDir: string,
    jobsPath: string,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AssetBakeError('timeout', 'asset bake timeout')),
        timeoutMs,
      );
    });
    try {
      const result = await Promise.race([
        runner.run({ projectDir, jobsPath, timeoutMs }),
        timeout,
      ]);
      const line = [result.stdout, result.stderr]
        .join('\n')
        .split('\n')
        .find((candidate) => candidate.startsWith(BAKE_OK_PREFIX) || candidate.startsWith(BAKE_ERROR_PREFIX));
      if (line === undefined) {
        throw new AssetBakeError(
          'bake_failed',
          result.stderr.length > 0 ? result.stderr : `bake tool exited with ${result.exitCode}`,
        );
      }
      if (line.startsWith(BAKE_ERROR_PREFIX)) {
        throw new AssetBakeError('bake_failed', this.describeToolErrors(line.slice(BAKE_ERROR_PREFIX.length)));
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private describeToolErrors(payload: string): string {
    const parsed = JSON.parse(payload) as {
      errors?: Array<{ file?: string; reason?: string; message?: string }>;
    };
    const errors = parsed.errors ?? [];
    if (errors.length === 0) {
      return 'bake failed';
    }
    return errors
      .map((error) => `${error.file ?? '?'}: ${error.reason ?? 'bake_failed'}: ${error.message ?? ''}`)
      .join('; ');
  }

  private async readOutputs(
    projectDir: string,
    slug: string,
    jobs: BakeJob[],
  ): Promise<Map<string, Buffer>> {
    const produced = new Map<string, Buffer>();
    for (const job of jobs) {
      const bytes = await readFile(join(projectDir, 'packages', slug, job.output));
      if (bytes.byteLength > MAX_BAKED_FILE_SIZE) {
        throw new AssetBakeError(
          'baked_file_too_large',
          `baked_file_too_large: ${job.output} (${bytes.byteLength} bytes)`,
        );
      }
      produced.set(job.output, bytes);
    }
    return produced;
  }

  private async acquire(): Promise<void> {
    const limit = Math.max(1, this.options?.maxConcurrency ?? 1);
    if (this.active < limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next !== undefined) {
      next();
    }
  }
}
