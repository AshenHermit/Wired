import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { packageError } from '../package-errors';
import { InjectRepository } from '@nestjs/typeorm';
import {
  PackageFileEntry,
  PackageRuntimeDependency,
  PackageRuntimeManifest,
} from '@wired-io/shared';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Repository } from 'typeorm';
import { Room } from 'src/database/entities/room.entity';
import { errorMessage } from 'src/common/errors';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import {
  DependentRoomPackage,
  PackageClosureResolver,
  ResolvedClosure,
} from '../publish/package-closure-resolver';
import {
  PinnedPackage,
  pinnedPackageLoader,
  walkPinnedClosure,
} from '../publish/package-dependency-graph';
import { sha256Hex } from '../storage/package-hash';
import { resolvePackagePath } from '../storage/package-path';
import {
  assertUniquePackageSlugs,
  buildSceneDependencies,
  rewritePackageReferences,
  stripExtResourceUids,
} from '../publish/package-runtime-references';
import { PackageReadUrlService } from './package-read-url.service';
import { AssetBakeService } from './asset-bake.service';
import { BAKED_SUFFIX } from './asset-bake.constants';
import { AssetBakeError, type BakeJob } from './asset-bake.types';
import type { PackageSlugIndex } from '../storage/package-slug-index';
import { PackageStorageService } from '../storage/package-storage.service';

export type { DependentRoomPackage };

const MANIFEST_FILENAME = 'manifest.json';

/** Bumped whenever the artifact layout or manifest shape changes. */
const ARTIFACT_FORMAT_VERSION = 'v2';

/** How many historical artifacts stay on disk per package/room/revision. */
const ARTIFACT_RETENTION = 3;

/** Artifact keys are sha256 hex digests, so they are safe path segments. */
const ARTIFACT_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * A per-room runtime artifact: the root package's files with every
 * `res://packages/<target>/...` reference rewritten to a pinned
 * `user://wired/rooms/<room>/packages/<slug>/<revision>-<artifactKey>/...`
 * location, plus the transitive dependency closure it was built from.
 *
 * `artifactKey` identifies the exact resolved closure of *this* package. A
 * same-revision publish of any transitive dependency changes it, so clients
 * never reuse stale files and a hot reload sees a new resource path.
 */
type RuntimeArtifact = {
  packageId: number;
  slug: string;
  name: string;
  revision: number;
  roomId: number;
  publishedAt: string;
  artifactKey: string;
  files: PackageFileEntry[];
  totalSize: number;
  dependencies: PackageRuntimeDependency[];
  sceneDependencies: Record<string, string[]>;
  dir: string;
};

/**
 * One file of one already-built runtime artifact.
 *
 * The ids are named rather than positional: the read token, the artifact path
 * and the HTTP route all carry `packageId`, `revision` and `roomId`, and a
 * transposed pair would resolve a file out of the wrong artifact.
 */
export interface RuntimeFileRequest {
  packageId: number;
  revision: number;
  roomId: number;
  artifactKey: string;
  filepath: string;
}

/**
 * Builds and caches per-room runtime artifacts from published raw package
 * files, rewrites package references to their runtime locations, verifies the
 * dependency closure (room, published state, referenced files, cycles) and
 * serves the resulting files.
 */
@Injectable()
export class PackageDeliveryService {
  /** Closure resolution, artifact keys and the dependent scan. */
  private readonly resolver: PackageClosureResolver;

  /** Artifacts currently being built, so concurrent calls share one build. */
  private readonly inFlight = new Map<string, Promise<RuntimeArtifact>>();

  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository: Repository<ScriptingPackage>,
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisionsRepository: Repository<ScriptingPackageRevision>,
    @InjectRepository(Room)
    private readonly roomsRepository: Repository<Room>,
    private readonly storage: PackageStorageService,
    private readonly readUrls: PackageReadUrlService,
    private readonly assetBake: AssetBakeService = new AssetBakeService(),
  ) {
    this.resolver = new PackageClosureResolver(
      revisionsRepository,
      storage,
      packagesRepository,
    );
  }

  /**
   * Every package id the runtime may hold state for in a room: the room's own
   * packages (including disabled and unpublished ones) plus the transitive
   * published dependency closure. Dependencies keep their own entities and
   * player components, so a runtime restart must not purge their save records.
   * A dependency whose package row was deleted is intentionally not included.
   */
  async collectRuntimePackageIds(roomId: number): Promise<number[]> {
    const roomPackages = await this.packagesRepository.find({
      where: { room: { id: roomId } },
    });
    const ids = await walkPinnedClosure(
      roomPackages.map((pkg) => pkg.id),
      {
        load: pinnedPackageLoader(this.revisionsRepository, this.storage),
        // A dependency whose row was deleted keeps no runtime state to purge.
        onDiscover: async (dependencyId) =>
          (await this.packagesRepository.findOne({
            where: { id: dependencyId },
          })) !== null,
      },
    );
    return [...ids].sort((left, right) => left - right);
  }

  async getRuntimeManifest(
    packageId: number,
    revision: number,
    roomId: number,
  ): Promise<PackageRuntimeManifest> {
    await this.assertValidRoom(roomId);
    const artifact = await this.ensureArtifact(packageId, revision, roomId);
    return {
      packageId: artifact.packageId,
      slug: artifact.slug,
      name: artifact.name,
      revision: artifact.revision,
      roomId: artifact.roomId,
      publishedAt: artifact.publishedAt,
      artifactKey: artifact.artifactKey,
      files: artifact.files,
      totalSize: artifact.totalSize,
      dependencies: artifact.dependencies,
      sceneDependencies: artifact.sceneDependencies,
      download: this.readUrls.createToken({ roomId, packageId, revision }),
    };
  }

  /**
   * Resolves a file of one exact artifact. The artifact key comes from the
   * manifest and is never re-resolved: a library publish between the manifest
   * and the last file must not silently switch to a different artifact.
   *
   * The request is an object because three of its five fields are numbers that
   * used to sit next to each other in a different order here, in the read token
   * and in the artifact path.
   */
  async resolveRuntimeFile(request: RuntimeFileRequest): Promise<{
    path: string;
    size: number;
  }> {
    const { packageId, revision, roomId, artifactKey, filepath } = request;
    await this.assertValidRoom(roomId);
    if (!ARTIFACT_KEY_RE.test(artifactKey)) {
      throw packageError(
        'package_artifact_not_found',
        'No runtime artifact was built for this package revision',
      );
    }
    const artifact = await this.readManifest(
      this.artifactDir(packageId, revision, roomId, artifactKey),
    );
    if (!artifact) {
      throw packageError(
        'package_artifact_not_found',
        'No runtime artifact was built for this package revision',
      );
    }
    const entry = artifact.files.find((file) => file.filepath === filepath);
    if (!entry) {
      throw packageError(
        'package_artifact_file_missing',
        `File ${filepath} is not part of the runtime artifact`,
      );
    }
    return {
      path: resolvePackagePath(artifact.dir, filepath),
      size: entry.size,
    };
  }

  /**
   * Rejects an unusable room before any artifact is built or written. The
   * public runtime routes take `room` from the query string, so this is the
   * only thing that stops arbitrary integers from creating artifact copies.
   */
  private async assertValidRoom(roomId: number): Promise<void> {
    if (!Number.isInteger(roomId) || roomId <= 0) {
      throw packageError('room_invalid', 'Room id must be a positive integer');
    }
    const exists = await this.roomsRepository.exist({ where: { id: roomId } });
    if (!exists) {
      throw packageError('room_not_found', `Room ${roomId} not found`);
    }
  }

  /**
   * Finds every room package that (transitively) references `packageId`, so a
   * publication can re-dispatch the runtimes that consume it as a library.
   */
  findDependentRoomPackages(
    packageId: number,
  ): Promise<DependentRoomPackage[]> {
    return this.resolver.findDependentRoomPackages(packageId);
  }

  /**
   * Deletes every runtime artifact of the package. A rewritten revision keeps
   * its artifact key (the key hashes ids and revisions only), so a cached
   * artifact would otherwise be served with the pre-rewrite bytes.
   */
  async invalidateArtifacts(packageId: number): Promise<void> {
    await rm(path.join(this.storage.packageRootDir(packageId), 'runtime'), {
      recursive: true,
      force: true,
    });
  }

  /** Drops both the in-memory closure cache and the on-disk artifacts. */
  async invalidatePackage(packageId: number): Promise<void> {
    this.resolver.invalidatePackage(packageId);
    await this.invalidateArtifacts(packageId);
  }

  /**
   * Returns a cached artifact or builds a new one. A cache hit is identified
   * by the root package's artifact key (the hash of its resolved closure), so a
   * dependency publishing a new revision naturally produces a different path
   * and a fresh build; stale bytes are never served.
   */
  private async ensureArtifact(
    packageId: number,
    revision: number,
    roomId: number,
  ): Promise<RuntimeArtifact> {
    const key = `${packageId}:${revision}:${roomId}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const promise = this.buildArtifact(packageId, revision, roomId);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async buildArtifact(
    packageId: number,
    revision: number,
    roomId: number,
  ): Promise<RuntimeArtifact> {
    await this.assertRootPackageExists(packageId);

    const resolved = await this.resolver.resolve(packageId, revision, roomId);
    const slug = resolved.slugByPackage.get(resolved.packageId);
    if (slug === undefined) {
      // Slugs are backfilled before publication; a slugless package would
      // produce a runtime path the client cannot address.
      throw new Error(`package_slug_missing:${resolved.packageId}`);
    }
    const artifactKey = resolved.artifactKeys.get(packageId);
    if (!artifactKey) {
      // The root is always part of its own closure; this is an invariant.
      throw packageError(
        'package_artifact_key_missing',
        'The artifact key is missing from the resolved closure',
      );
    }
    const dir = this.artifactDir(packageId, revision, roomId, artifactKey);

    // Validate before the cache decision: an artifact written by an older
    // build may already contain a shadowed slug and must not be served.
    try {
      assertUniquePackageSlugs(resolved.slugByPackage);
    } catch (error) {
      throw new BadRequestException(
        {
          code: 'package_slug_shadowed',
          message: errorMessage(error),
        },
        { cause: error },
      );
    }

    const cached = await this.readManifest(dir);
    const artifact = cached ?? (await this.writeArtifact(dir, resolved, slug));
    await this.pruneArtifacts(packageId, revision, roomId, artifactKey);
    return artifact;
  }

  private async assertRootPackageExists(packageId: number): Promise<void> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId },
    });
    if (!pkg) {
      throw new NotFoundException(
        `ScriptingPackage with id=${packageId} not found`,
      );
    }
  }

  private artifactDir(
    packageId: number,
    revision: number,
    roomId: number,
    artifactKey: string,
  ): string {
    return path.join(
      this.storage.packageRootDir(packageId),
      'runtime',
      ARTIFACT_FORMAT_VERSION,
      String(roomId),
      String(revision),
      artifactKey,
    );
  }

  /**
   * Keeps the newest `ARTIFACT_RETENTION` artifacts of one
   * `<package>/<room>/<revision>` and deletes older complete directories. The
   * current artifact is always kept even if its mtime is older (for example
   * after a restore). Only directories of this exact revision are touched.
   */
  private async pruneArtifacts(
    packageId: number,
    revision: number,
    roomId: number,
    keepKey: string,
  ): Promise<void> {
    const base = path.join(
      this.storage.packageRootDir(packageId),
      'runtime',
      ARTIFACT_FORMAT_VERSION,
      String(roomId),
      String(revision),
    );
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return;
    }
    const candidates: Array<{ name: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ARTIFACT_KEY_RE.test(entry.name)) {
        continue;
      }
      try {
        const info = await stat(path.join(base, entry.name));
        candidates.push({ name: entry.name, mtimeMs: info.mtimeMs });
      } catch {
        // A concurrent prune may have removed it already.
      }
    }
    if (candidates.length <= ARTIFACT_RETENTION) {
      return;
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Set<string>([keepKey]);
    for (const candidate of candidates) {
      if (keep.size >= ARTIFACT_RETENTION) {
        break;
      }
      keep.add(candidate.name);
    }
    for (const candidate of candidates) {
      if (keep.has(candidate.name)) {
        continue;
      }
      await rm(path.join(base, candidate.name), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }

  private async readManifest(dir: string): Promise<RuntimeArtifact | null> {
    try {
      const body = JSON.parse(
        await readFile(path.join(dir, MANIFEST_FILENAME), 'utf8'),
      ) as Omit<RuntimeArtifact, 'dir'>;
      return { ...body, dir };
    } catch {
      return null;
    }
  }

  private async writeArtifact(
    dir: string,
    resolved: ResolvedClosure,
    slug: string,
  ): Promise<RuntimeArtifact> {
    const staging = `${dir}.staging-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      await mkdir(staging, { recursive: true });

      const textByPath = new Map(
        resolved.rootTextFiles.map((file) => [file.filepath, file.text]),
      );
      // Raw glTF cannot be loaded by an exported game: bake it into a
      // self-contained scene and point the scenes at that file.
      let jobs: BakeJob[];
      let baked: Map<string, Buffer>;
      try {
        jobs = this.assetBake.planJobs(resolved, slug);
        baked = await this.assetBake.bake(resolved, slug, jobs);
      } catch (error) {
        throw this.assetBakeFailure(error, slug);
      }
      // Runtime paths carry the artifact directory: `.../packages/<slug>/<revision>-<key>/`.
      const artifactPath = `packages/${slug}/${resolved.revision}-${resolved.artifactKeys.get(resolved.packageId)!}`;
      const assetRewrites = jobs
        .filter((job) => baked.has(job.output))
        .map((job) => ({
          from: `${artifactPath}/${job.source}`,
          to: `${artifactPath}/${job.output}`,
        }));
      const files: PackageFileEntry[] = [];
      for (const entry of resolved.rootFiles) {
        // Editor import presets point at `.godot/imported/...` remaps that only
        // exist inside an editor; the native runtime derives its own sidecars.
        if (entry.filepath.endsWith('.import')) continue;
        // The baked scene replaces the raw model: the runtime cannot load it and
        // no reference should point at it any more, so it is not shipped.
        if (baked.has(`${entry.filepath}${BAKED_SUFFIX}`)) continue;
        const data = resolved.bytes.get(entry.filepath)!;
        const rewritten = textByPath.has(entry.filepath)
          ? this.rewriteText(
              entry.filepath,
              textByPath.get(entry.filepath)!,
              resolved.roomId,
              resolved.revisionByPackage,
              resolved.artifactKeys,
              resolved.slugByPackage,
              assetRewrites,
            )
          : data;
        // Validate every written path symmetrically with the read paths: a
        // manifest must never place a file outside its artifact directory.
        const target = resolvePackagePath(staging, entry.filepath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, rewritten);
        files.push({
          filepath: entry.filepath,
          size: rewritten.byteLength,
          sha256: sha256Hex(rewritten),
        });
      }
      for (const [output, bytes] of baked) {
        const target = resolvePackagePath(staging, output);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
        files.push({
          filepath: output,
          size: bytes.byteLength,
          sha256: sha256Hex(bytes),
        });
      }
      // Deterministic codepoint order, independent of the host locale.
      files.sort((a, b) =>
        a.filepath < b.filepath ? -1 : a.filepath > b.filepath ? 1 : 0,
      );

      const artifactKey = resolved.artifactKeys.get(resolved.packageId)!;
      const sceneDependencies = buildSceneDependencies(
        resolved.packageId,
        resolved.rootTextFiles,
        resolved.dependencyTextFiles,
        this.toSlugIndex(resolved.slugByPackage, resolved.roomId),
        resolved.roomId,
      );
      const directDependencies: PackageRuntimeDependency[] =
        resolved.directDependencyIds.map((id) => ({
          packageId: id,
          revision: resolved.revisionByPackage.get(id)!,
          name: resolved.nameByPackage.get(id)!,
          artifactKey: resolved.artifactKeys.get(id)!,
        }));
      const manifestBody = {
        packageId: resolved.packageId,
        slug,
        name: resolved.name,
        revision: resolved.revision,
        roomId: resolved.roomId,
        publishedAt: resolved.publishedAt,
        artifactKey,
        files,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
        dependencies: directDependencies,
        sceneDependencies,
      };
      await writeFile(
        path.join(staging, MANIFEST_FILENAME),
        JSON.stringify(manifestBody),
      );

      await rename(staging, dir);
      return { ...manifestBody, dir };
    } catch (error) {
      // Remove the staging dir on any build failure. A concurrent build may
      // have won the rename, in which case its manifest is already in place.
      await rm(staging, { recursive: true, force: true }).catch(
        () => undefined,
      );
      const cached = await this.readManifest(dir);
      if (cached) {
        return cached;
      }
      throw error;
    }
  }

  /** Turns a bake failure into the project's HTTP error envelope. */
  private assetBakeFailure(error: unknown, slug: string): Error {
    if (error instanceof AssetBakeError) {
      return new BadRequestException(
        {
          code: error.code,
          message: error.message,
          packageSlug: slug,
          reason: error.reason,
        },
        { cause: error },
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private rewriteText(
    filepath: string,
    text: string,
    roomId: number,
    revisionByPackage: Map<number, number>,
    artifactKeys: Map<number, string>,
    slugByPackage: Map<number, string>,
    assetRewrites: ReadonlyArray<{ from: string; to: string }> = [],
  ): Buffer {
    let rewritten: string;
    try {
      rewritten = rewritePackageReferences(text, {
        roomId,
        revisionByPackage,
        artifactKeyByPackage: artifactKeys,
        slugByPackage,
      });
    } catch (error) {
      throw new BadRequestException(
        {
          code: 'package_reference_unresolved',
          filepath,
          message: errorMessage(error),
        },
        { cause: error },
      );
    }
    let target = stripExtResourceUids(filepath, rewritten);
    // Package references are already turned into runtime paths, so the baked
    // scene is matched by its artifact-relative path.
    for (const rewrite of assetRewrites) {
      // Whole references only: an authored `dude.glb.scn` must not turn into
      // `dude.glb.scn.scn`, and a longer name must not be truncated.
      const escaped = rewrite.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      target = target.replace(new RegExp(`${escaped}(?![\\w.])`, 'g'), rewrite.to);
    }
    return Buffer.from(target, 'utf8');
  }

  /**
   * The slug index of one closure: only the packages reachable from this
   * artifact are addressable, so resolution never needs a database round-trip.
   * Every closure package belongs to the artifact room for resolution
   * purposes: a global dependency is reachable from that room's artifact too.
   */
  private toSlugIndex(
    slugByPackage: ReadonlyMap<number, string>,
    roomId: number,
  ): PackageSlugIndex {
    return {
      byId: new Map(
        [...slugByPackage].map(([id, slug]) => [id, { slug, roomId }]),
      ),
      byRoomSlug: new Map(
        [...slugByPackage].map(
          ([id, slug]) => [`${roomId}:${slug}`, id] as [string, number],
        ),
      ),
      byGlobalSlug: new Map(
        [...slugByPackage].map(([id, slug]) => [slug, id] as [string, number]),
      ),
    };
  }
}
