import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import config from 'src/config/config';

import type { ResolvedClosure } from '../publish/package-closure-resolver';
import { sha256Hex } from '../storage/package-hash';
import { AssetBakeCache } from './asset-bake-cache';
import { AssetBakeService } from './asset-bake.service';
import { ChildProcessBakeRunner } from './godot-bake.runner';

const execFileAsync = promisify(execFile);

const maybe = process.env.WIRED_GODOT_INTEGRATION === '1' ? it : it.skip;

const toolDir = config().assetBake.projectPath;
const dudeDir = join(config().godot.projectPath, 'examples', 'cura_player', 'player');
const dudeSource = readFileSync(join(dudeDir, 'dude.glb'));
const dudePreset = readFileSync(join(dudeDir, 'dude.glb.import'), 'utf8');

/** The real model plus every file its preset references. */
function closureFromCuraPlayer(): ResolvedClosure {
  const bytes = new Map<string, Buffer>();
  const rootFiles = [];
  for (const name of readdirSync(dudeDir)) {
    const tracked =
      name === 'dude.glb' ||
      name === 'dude.glb.import' ||
      name.endsWith('.tres') ||
      name.endsWith('.png');
    if (!tracked) continue;
    const data = readFileSync(join(dudeDir, name));
    const filepath = `player/${name}`;
    bytes.set(filepath, data);
    rootFiles.push({ filepath, size: data.length, sha256: sha256Hex(data) });
  }
  return {
    packageId: 5,
    name: 'Cura Player',
    revision: 36,
    roomId: 2,
    publishedAt: new Date(0).toISOString(),
    revisionByPackage: new Map([[5, 36]]),
    nameByPackage: new Map([[5, 'Cura Player']]),
    slugByPackage: new Map([[5, 'cura_player']]),
    artifactKeys: new Map([[5, 'test']]),
    directDependencyIds: [],
    rootTextFiles: [],
    dependencyTextFiles: new Map(),
    rootFiles,
    bytes,
  };
}

const jobs = [
  { source: 'player/dude.glb', output: 'player/dude.glb.scn', preset: dudePreset },
];

async function inspectBake(
  bytes: Buffer,
): Promise<{ loop_modes: number[]; materials: string[]; textures: string[] }> {
  const tmpDir = join(toolDir, 'tests', 'tmp');
  const tmpPath = join(tmpDir, `bake-${Date.now()}.scn`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(tmpPath, bytes);
  try {
    const { stdout } = await execFileAsync(
      config().assetBake.executablePath,
      [
        '--headless',
        '--path',
        toolDir,
        '--script',
        'res://tests/inspect_bake.gd',
        '--',
        `res://tests/tmp/${basename(tmpPath)}`,
      ],
      { timeout: 60_000 },
    );
    const line = stdout.split('\n').find((entry) => entry.startsWith('WIRED_INSPECT_OK '));
    if (!line) throw new Error(`no WIRED_INSPECT_OK in ${stdout}`);
    return JSON.parse(line.slice('WIRED_INSPECT_OK '.length));
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

maybe(
  'Р·Р°РїРµРєР°РµС‚ СЂРµР°Р»СЊРЅС‹Р№ dude.glb СЃ РµРіРѕ РїСЂРµСЃРµС‚РѕРј',
  async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'asset-bake-integration-'));
    try {
      const service = new AssetBakeService(
        new AssetBakeCache(cacheDir, 512 * 1024 * 1024),
        new ChildProcessBakeRunner(config().assetBake.executablePath),
        {
          projectPath: toolDir,
          executablePath: config().assetBake.executablePath,
          timeoutMs: 120_000,
          maxConcurrency: 1,
        },
      );

      const result = await service.bake(closureFromCuraPlayer(), 'cura_player', jobs);
      const scene = await inspectBake(result.get('player/dude.glb.scn')!);

      const expectedLoops = (dudePreset.match(/"settings\/loop_mode": 1/g) ?? []).length;
      const expectedMaterials = (
        dudePreset.match(/"use_external\/enabled": true/g) ?? []
      ).length;
      expect(expectedLoops).toBeGreaterThan(0);

      expect(scene.loop_modes.filter((mode) => mode === 1)).toHaveLength(expectedLoops);
      expect(scene.materials).toHaveLength(expectedMaterials);
      // Materials share textures: embedding the same picture once per material
      // doubles the artifact for no reason.
      expect(new Set(scene.textures).size).toBe(scene.textures.length);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  },
  180_000,
);

void dudeSource;


