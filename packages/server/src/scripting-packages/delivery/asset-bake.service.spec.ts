import type { PackageFileEntry } from '@wired-io/shared';

import type { ResolvedClosure } from '../publish/package-closure-resolver';
import type { PackageTextFile } from '../publish/package-runtime-references';
import { AssetBakeService } from './asset-bake.service';
import { AssetBakeError } from './asset-bake.types';

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

  it('отказывает на ссылке из зависимости на её же .glb', () => {
    const closure = makeClosure({
      dependencyTextFiles: new Map([
        [9, [{ filepath: 'scene.tscn', text: 'path="res://packages/lib/model.glb"' }]],
      ]),
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
