import type { ResolvedClosure } from '../publish/package-closure-resolver';
import type { PackageTextFile } from '../publish/package-runtime-references';
import { BAKED_SUFFIX, UNSUPPORTED_ASSET_EXTENSIONS } from './asset-bake.constants';
import { AssetBakeError, type BakeJob } from './asset-bake.types';

const GLB_EXTENSION = '.glb';
const IMPORT_EXTENSION = '.import';
const COMMENT_PREFIXES = ['#', ';'];

/** `res://packages/<slug>/<file>` where the file is an importable 3D asset. */
const ASSET_REFERENCE_RE =
  /res:\/\/packages\/([^/"\s]+)\/([^"\s]+\.(?:glb|gltf|fbx|dae|obj|blend))/gi;

/**
 * Decides which raw assets of a resolved closure have to be baked before the
 * runtime artifact is written.
 *
 * Only the root package's bytes are materialized by the closure, so a reference
 * to another package's asset cannot be baked: that is a build error instead of a
 * scene that points at a file the runtime cannot load.
 */
export class AssetBakeService {
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
}
