import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import {
  DependentRoomPackage,
  PackageClosureResolver,
  ResolvedClosure,
} from './package-closure-resolver';
import { sha256Hex } from './package-hash';
import { resolvePackagePath } from './package-path';
import {
  buildSceneDependencies,
  rewritePackageReferences,
  stripExtResourceUids,
} from './package-runtime-references';
import { PackageReadUrlService } from './package-read-url.service';
import { PackageStorageService } from './package-storage.service';

export type { DependentRoomPackage };

const MANIFEST_FILENAME = 'manifest.json';

/** Bumped whenever the artifact layout or manifest shape changes. */
const ARTIFACT_FORMAT_VERSION = 'v1';

/** How many historical artifacts stay on disk per package/room/revision. */
const ARTIFACT_RETENTION = 3;

/** Artifact keys are sha256 hex digests, so they are safe path segments. */
const ARTIFACT_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * A per-room runtime artifact: the root package's files with every
 * `res://packages/<id>/...` reference rewritten to a pinned
 * `user://wired/rooms/<room>/packages/<id>/<revision>-<artifactKey>/...`
 * location, plus the transitive dependency closure it was built from.
 *
 * `artifactKey` identifies the exact resolved closure of *this* package. A
 * same-revision publish of any transitive dependency changes it, so clients
 * never reuse stale files and a hot reload sees a new resource path.
 */
type RuntimeArtifact = {
  packageId: number;
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
    const ids = new Set<number>(roomPackages.map((pkg) => pkg.id));
    const queue = [...ids];
    while (queue.length > 0) {
      const packageId = queue.pop() as number;
      const latest = await this.revisionsRepository.findOne({
        where: { package: { id: packageId }, status: 'published' },
        relations: { package: true },
        order: { revision: 'DESC' },
      });
      if (!latest) continue;
      const pins = await this.storage.readPinnedDependencies(
        packageId,
        latest.revision,
      );
      if (!pins) continue;
      for (const dependencyId of pins.keys()) {
        if (ids.has(dependencyId)) continue;
        const exists = await this.packagesRepository.findOne({
          where: { id: dependencyId },
        });
        if (!exists) continue;
        ids.add(dependencyId);
        queue.push(dependencyId);
      }
    }
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
   */
  async resolveRuntimeFile(
    packageId: number,
    revision: number,
    roomId: number,
    artifactKey: string,
    filepath: string,
  ): Promise<{ path: string; size: number }> {
    await this.assertValidRoom(roomId);
    if (!ARTIFACT_KEY_RE.test(artifactKey)) {
      throw new NotFoundException('package_artifact_not_found');
    }
    const artifact = await this.readManifest(
      this.artifactDir(packageId, revision, roomId, artifactKey),
    );
    if (!artifact) {
      throw new NotFoundException('package_artifact_not_found');
    }
    const entry = artifact.files.find((file) => file.filepath === filepath);
    if (!entry) {
      throw new NotFoundException(
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
      throw new BadRequestException('room_invalid');
    }
    const exists = await this.roomsRepository.exist({ where: { id: roomId } });
    if (!exists) {
      throw new NotFoundException(`Room ${roomId} not found`);
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
    const artifactKey = resolved.artifactKeys.get(packageId);
    if (!artifactKey) {
      // The root is always part of its own closure; this is an invariant.
      throw new BadRequestException('package_artifact_key_missing');
    }
    const dir = this.artifactDir(packageId, revision, roomId, artifactKey);

    const cached = await this.readManifest(dir);
    const artifact = cached ?? (await this.writeArtifact(dir, resolved));
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
  ): Promise<RuntimeArtifact> {
    const staging = `${dir}.staging-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      await mkdir(staging, { recursive: true });

      const textByPath = new Map(
        resolved.rootTextFiles.map((file) => [file.filepath, file.text]),
      );
      const files: PackageFileEntry[] = [];
      for (const entry of resolved.rootFiles) {
        const data = resolved.bytes.get(entry.filepath)!;
        const rewritten = textByPath.has(entry.filepath)
          ? this.rewriteText(
              entry.filepath,
              textByPath.get(entry.filepath)!,
              resolved.roomId,
              resolved.revisionByPackage,
              resolved.artifactKeys,
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
      // Deterministic codepoint order, independent of the host locale.
      files.sort((a, b) =>
        a.filepath < b.filepath ? -1 : a.filepath > b.filepath ? 1 : 0,
      );

      const artifactKey = resolved.artifactKeys.get(resolved.packageId)!;
      const sceneDependencies = buildSceneDependencies(
        resolved.packageId,
        resolved.rootTextFiles,
        resolved.dependencyTextFiles,
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

  private rewriteText(
    filepath: string,
    text: string,
    roomId: number,
    revisionByPackage: Map<number, number>,
    artifactKeys: Map<number, string>,
  ): Buffer {
    let rewritten: string;
    try {
      rewritten = rewritePackageReferences(text, {
        roomId,
        revisionByPackage,
        artifactKeyByPackage: artifactKeys,
      });
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return Buffer.from(stripExtResourceUids(filepath, rewritten), 'utf8');
  }
}
