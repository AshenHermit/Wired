import { Logger } from '@nestjs/common';
import type { PackageFileEntry } from '@wired-io/shared';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ResolvedClosure } from '../publish/package-closure-resolver';
import type { PackageTextFile } from '../publish/package-runtime-references';
import { AssetBakeCache } from './asset-bake-cache';
import { AssetBakeService } from './asset-bake.service';
import { AssetBakeError, type BakeJob } from './asset-bake.types';
import type { BakeRunner } from './godot-bake.runner';

type ClosureOptions = {
  files?: string[];
  presetFiles?: Record<string, string>;
  textFiles?: PackageTextFile[];
  dependencyTextFiles?: Map<number, PackageTextFile[]>;
  slugByPackage?: Map<number, string>;
};

function makeClosure(options: ClosureOptions = {}): ResolvedClosure {
  const rootFiles: PackageFileEntry[] = [];
  const bytes = new Map<string, Buffer>();
  for (const filepath of options.files ?? []) {
    rootFiles.push({ filepath, size: 3, sha256: 'sha' } as PackageFileEntry);
    bytes.set(filepath, Buffer.from('raw'));
  }
  for (const [filepath, text] of Object.entries(options.presetFiles ?? {})) {
    rootFiles.push({ filepath, size: Buffer.byteLength(text), sha256: 'sha' } as PackageFileEntry);
    bytes.set(filepath, Buffer.from(text, 'utf8'));
  }
  return {
    packageId: 5,
    name: 'Heroes',
    revision: 3,
    roomId: 7,
    publishedAt: '2026-11-12T00:00:00.000Z',
    revisionByPackage: new Map([[5, 3]]),
    nameByPackage: new Map([[5, 'Heroes']]),
    slugByPackage: options.slugByPackage ?? new Map([[5, 'hero']]),
    artifactKeys: new Map([[5, 'key']]),
    rootFiles,
    bytes,
    rootTextFiles: options.textFiles ?? [],
    dependencyTextFiles: options.dependencyTextFiles ?? new Map(),
    directDependencyIds: [],
  };
}

/** Writes the job outputs into the temp project and answers like the real tool. */
class FakeRunner implements BakeRunner {
  calls = 0;
  stdout = '';
  stderr = '';
  delayMs = 0;
  payload = Buffer.from('baked-scene');

  async run(options: { projectDir: string; jobsPath: string; timeoutMs: number }) {
    this.calls += 1;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const jobs = JSON.parse(readFileSync(options.jobsPath, 'utf8')) as {
      jobs: Array<{ output: string }>;
    };
    const results = jobs.jobs.map((job) => {
      const target = join(options.projectDir, job.output);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, this.payload);
      return { output: job.output, size: this.payload.length };
    });
    const stdout =
      this.stdout.length > 0
        ? this.stdout
        : `WIRED_BAKE_OK ${JSON.stringify({ results })}`;
    return {
      exitCode: this.stdout.length > 0 ? 1 : 0,
      stdout,
      stderr: this.stderr,
    };
  }
}

describe('AssetBakeService.planJobs', () => {
  const service = new AssetBakeService();

  it('планирует .glb с пресетом из соседнего .import', () => {
    const closure = makeClosure({
      files: ['player/dude.glb'],
      presetFiles: { 'player/dude.glb.import': '[remap]\n\nimporter="scene"\n' },
    });

    expect(service.planJobs(closure, 'hero')).toEqual([
      {
        source: 'player/dude.glb',
        output: 'player/dude.glb.scn',
        preset: '[remap]\n\nimporter="scene"\n',
      },
    ]);
  });

  it('планирует .glb без пресета', () => {
    const closure = makeClosure({ files: ['player/dude.glb'] });

    expect(service.planJobs(closure, 'hero')[0].preset).toBeNull();
  });

  it('отказывает на .gltf с внешними буферами', () => {
    const closure = makeClosure({ files: ['player/model.gltf'] });

    expect(() => service.planJobs(closure, 'hero')).toThrow(AssetBakeError);
    expect(() => service.planJobs(closure, 'hero')).toThrow(/unsupported_asset_format.*model\.gltf/);
  });

  it('разрешает библиотеке ссылаться на свой же .glb', () => {
    const closure = makeClosure({
      dependencyTextFiles: new Map([
        [9, [{ filepath: 'scene.tscn', text: 'path="res://packages/lib/model.glb"' }]],
      ]),
      slugByPackage: new Map([
        [5, 'hero'],
        [9, 'lib'],
      ]),
    });

    expect(service.planJobs(closure, 'hero')).toEqual([]);
  });

  it('отказывает на ссылке корня на .glb зависимости', () => {
    const closure = makeClosure({
      textFiles: [{ filepath: 'main.tscn', text: 'path="res://packages/lib/model.glb"' }],
      slugByPackage: new Map([
        [5, 'hero'],
        [9, 'lib'],
      ]),
    });

    expect(() => service.planJobs(closure, 'hero')).toThrow(/dependency_asset_unsupported/);
  });

  it('не считает упоминание в комментарии ссылкой', () => {
    const closure = makeClosure({
      textFiles: [{ filepath: 'notes.gd', text: '# res://packages/lib/model.glb' }],
      slugByPackage: new Map([
        [5, 'hero'],
        [9, 'lib'],
      ]),
    });

    expect(service.planJobs(closure, 'hero')).toEqual([]);
  });
});

describe('AssetBakeService.bake', () => {
  const scnBytes = Buffer.from('baked-scene');
  let cacheDir: string;
  let projectDir: string;
  let runner: FakeRunner;
  let jobs: BakeJob[];

  const createService = (timeoutMs = 30_000) =>
    new AssetBakeService(
      new AssetBakeCache(cacheDir, 1024 * 1024),
      runner,
      {
        projectPath: projectDir,
        executablePath: 'godot',
        timeoutMs,
        maxConcurrency: 1,
      },
    );

  const closure = () =>
    makeClosure({
      files: ['player/dude.glb', 'player/other.glb'],
      presetFiles: { 'player/dude.glb.import': '[remap]\n\nimporter="scene"\n' },
    });

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'asset-bake-cache-spec-'));
    projectDir = mkdtempSync(join(tmpdir(), 'asset-bake-project-spec-'));
    writeFileSync(join(projectDir, 'project.godot'), 'config_version=5\n');
    writeFileSync(join(projectDir, 'bake_tool.gd'), 'class_name WiredBakeTool\n');
    writeFileSync(join(projectDir, 'wired_bake.gd'), 'extends SceneTree\n');
    runner = new FakeRunner();
    jobs = [{ source: 'player/dude.glb', output: 'player/dude.glb.scn', preset: null }];
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('на попадании в кэш не запускает процесс', async () => {
    const service = createService();
    await service.bake(closure(), 'hero', jobs);
    const baked = await service.bake(closure(), 'hero', jobs);

    expect(runner.calls).toBe(1);
    expect(baked.get('player/dude.glb.scn')?.equals(scnBytes)).toBe(true);
  });

  it('падает с package_asset_bake_failed на WIRED_BAKE_ERROR', async () => {
    runner.stdout =
      'WIRED_BAKE_ERROR {"errors":[{"file":"packages/hero/player/dude.glb","reason":"gltf_import_failed","message":"boom"}]}';

    await expect(createService().bake(closure(), 'hero', jobs)).rejects.toThrow(
      /dude\.glb.*gltf_import_failed.*boom/,
    );
  });

  it('убивает процесс по таймауту', async () => {
    runner.delayMs = 50;

    await expect(createService(10).bake(closure(), 'hero', jobs)).rejects.toThrow(/timeout/);
  });

  it('отказывает, если запечённый файл больше 64 МиБ', async () => {
    runner.payload = Buffer.alloc(67_108_865);

    await expect(
      createService().bake(closure(), 'hero', [{ ...jobs[0], output: 'big.scn' }]),
    ).rejects.toThrow(/baked_file_too_large/);
  });

  it('держит maxConcurrency: вторая запечка ждёт первую', async () => {
    runner.delayMs = 20;
    const service = createService();
    const otherJobs: BakeJob[] = [
      { source: 'player/other.glb', output: 'player/other.glb.scn', preset: null },
    ];

    const first = service.bake(closure(), 'hero', jobs);
    const second = service.bake(closure(), 'hero', otherJobs);
    await first;
    expect(runner.calls).toBe(1);
    await second;
    expect(runner.calls).toBe(2);
  });

  it('пишет предупреждения инструмента в лог', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    runner.stdout = `WIRED_BAKE_OK ${JSON.stringify({
      results: [{ output: 'player/dude.glb.scn', warnings: ['animation "Ghost" is missing'] }],
    })}`;

    await createService().bake(closure(), 'hero', jobs);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ghost'));
    warn.mockRestore();
  });
});
