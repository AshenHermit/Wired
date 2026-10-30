import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  PackageFileEntry,
  PackageRuntimeDependency,
  PackageRuntimeManifest,
} from '@wired-io/shared';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { sha256Hex } from './package-hash';
import { MAX_PACKAGE_FILE_SIZE } from './package-manifest';
import { resolvePackagePath } from './package-path';
import {
  buildSceneDependencies,
  collectPackageReferences,
  decodePackageText,
  isTextPackageFile,
  PackageFileReference,
  PackageTextFile,
  rewritePackageReferences,
  stripExtResourceUids,
} from './package-runtime-references';
import { PackageReadUrlService } from './package-read-url.service';
import { PackageStorageService } from './package-storage.service';

const MANIFEST_FILENAME = 'manifest.json';

/**
 * A per-room runtime artifact: the root package's files with every
 * `res://packages/<id>/...` reference rewritten to a pinned
 * `user://wired/rooms/<room>/packages/<id>/<revision>/...` location, plus the
 * transitive dependency closure it was built from.
 */
type RuntimeArtifact = {
  packageId: number;
  name: string;
  revision: number;
  roomId: number;
  publishedAt: string;
  files: PackageFileEntry[];
  totalSize: number;
  dependencies: PackageRuntimeDependency[];
  sceneDependencies: Record<string, string[]>;
  dir: string;
};

/** Everything resolved from raw published files before any bytes are written. */
type ResolvedClosure = {
  packageId: number;
  name: string;
  revision: number;
  roomId: number;
  publishedAt: string;
  sortedClosure: Array<[number, number]>;
  revisionByPackage: Map<number, number>;
  rootFiles: PackageFileEntry[];
  bytes: Map<string, Buffer>;
  rootTextFiles: PackageTextFile[];
  dependencyTextFiles: Map<number, PackageTextFile[]>;
  directDependencies: PackageRuntimeDependency[];
};

type LoadedRevision = {
  revision: number;
  files: PackageFileEntry[];
  publishedAt: string;
  name: string;
  room: { id: number } | null;
};

/** One element of the result of `findDependentRoomPackages`. */
type DependentRoomPackage = {
  packageId: number;
  roomId: number;
  revision: number;
};

/** A package's latest usable published revision, as seen by the scan. */
type LatestPublishedRevision = {
  revision: number;
  files: PackageFileEntry[];
  roomId: number | null;
};

/**
 * Builds and caches per-room runtime artifacts from published raw package
 * files, rewrites package references to their runtime locations, verifies the
 * dependency closure (room, published state, referenced files, cycles) and
 * serves the resulting files.
 */
@Injectable()
export class PackageDeliveryService {
  private readonly logger = new Logger(PackageDeliveryService.name);

  /** Artifacts currently being built, so concurrent calls share one build. */
  private readonly inFlight = new Map<string, Promise<RuntimeArtifact>>();
  /**
   * Immutable published bytes, memoized so a cache hit never re-reads disk.
   * Bounded by total bytes (the per-file limit): oversized buffers are never
   * cached and the oldest entries are evicted first when the cap is reached.
   */
  private readonly fileBytes = new Map<string, Buffer>();
  private fileCacheBytes = 0;
  private readonly maxFileCacheBytes = MAX_PACKAGE_FILE_SIZE;

  constructor(
    @InjectRepository(ScriptingPackage)
    private readonly packagesRepository: Repository<ScriptingPackage>,
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisionsRepository: Repository<ScriptingPackageRevision>,
    private readonly storage: PackageStorageService,
    private readonly readUrls: PackageReadUrlService,
  ) {}

  async getRuntimeManifest(
    packageId: number,
    revision: number,
    roomId: number,
  ): Promise<PackageRuntimeManifest> {
    const artifact = await this.ensureArtifact(packageId, revision, roomId);
    return {
      packageId: artifact.packageId,
      name: artifact.name,
      revision: artifact.revision,
      roomId: artifact.roomId,
      publishedAt: artifact.publishedAt,
      files: artifact.files,
      totalSize: artifact.totalSize,
      dependencies: artifact.dependencies,
      sceneDependencies: artifact.sceneDependencies,
      download: this.readUrls.createToken({ roomId, packageId, revision }),
    };
  }

  async resolveRuntimeFile(
    packageId: number,
    revision: number,
    roomId: number,
    filepath: string,
  ): Promise<{ path: string; size: number }> {
    const artifact = await this.ensureArtifact(packageId, revision, roomId);
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
   * Finds every room package that (transitively) references `packageId`, so a
   * publication can re-dispatch the runtimes that consume it as a library.
   *
   * Loads the latest published revision of every package (global ones
   * included, since a global library can sit between two room packages), reads
   * the textual files and builds a reverse reference graph, then walks it from
   * `packageId`. Only room packages are returned, sorted by `packageId`, and
   * `packageId` itself is never included. When `packageId` belongs to a room,
   * dependents from other rooms are pruned: a room package may only reference
   * same-room or global packages. A package whose files cannot be read is
   * logged and skipped rather than failing the publication.
   */
  async findDependentRoomPackages(
    packageId: number,
  ): Promise<Array<{ packageId: number; roomId: number; revision: number }>> {
    const latestByPackage = await this.loadLatestPublishedRevisions();
    const root = latestByPackage.get(packageId);
    if (!root) {
      return [];
    }

    const dependentsByReferenced =
      await this.buildReverseReferenceGraph(latestByPackage);

    const result: DependentRoomPackage[] = [];
    const visited = new Set<number>([packageId]);
    const queue = [packageId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = dependentsByReferenced.get(current);
      if (!dependents) {
        continue;
      }
      for (const dependentId of dependents) {
        if (visited.has(dependentId)) {
          continue;
        }
        visited.add(dependentId);
        const entry = latestByPackage.get(dependentId);
        if (!entry) {
          continue;
        }
        if (entry.roomId === null) {
          // A global package has no runtime of its own, but is a valid hop.
          queue.push(dependentId);
          continue;
        }
        if (root.roomId !== null && entry.roomId !== root.roomId) {
          // A room package in another room cannot depend on this package.
          continue;
        }
        result.push({
          packageId: dependentId,
          roomId: entry.roomId,
          revision: entry.revision,
        });
        queue.push(dependentId);
      }
    }

    result.sort((a, b) => a.packageId - b.packageId);
    return result;
  }

  /**
   * Loads the latest published revision of every package. The DESC order makes
   * the first occurrence of each package its newest revision; a package whose
   * newest published row has no `publishedAt` is dropped entirely (the same
   * invariant `loadRevision` enforces), never falling back to an older row.
   */
  private async loadLatestPublishedRevisions(): Promise<
    Map<number, LatestPublishedRevision>
  > {
    const revisions = await this.revisionsRepository.find({
      where: { status: 'published' },
      relations: ['package', 'package.room'],
      order: { revision: 'DESC' },
    });

    const latestByPackage = new Map<number, LatestPublishedRevision>();
    const seen = new Set<number>();
    for (const row of revisions) {
      const id = row.package.id;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      if (!row.publishedAt) {
        continue;
      }
      latestByPackage.set(id, {
        revision: row.revision,
        files: row.files,
        roomId: row.package.room?.id ?? null,
      });
    }
    return latestByPackage;
  }

  /**
   * Builds `referenced package -> packages that reference it` from the textual
   * files of each package's latest published revision. A package whose files
   * cannot be read or decoded is logged and left out of the graph.
   */
  private async buildReverseReferenceGraph(
    latestByPackage: Map<number, LatestPublishedRevision>,
  ): Promise<Map<number, Set<number>>> {
    const dependentsByReferenced = new Map<number, Set<number>>();
    for (const [id, entry] of latestByPackage) {
      let references: PackageFileReference[];
      try {
        references = await this.collectRevisionReferences(id, entry);
      } catch (error) {
        this.logger.warn(
          `Skipping package ${id} during dependent scan: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      for (const ref of references) {
        if (ref.packageId === id) {
          continue;
        }
        const dependents = dependentsByReferenced.get(ref.packageId);
        if (dependents) {
          dependents.add(id);
        } else {
          dependentsByReferenced.set(ref.packageId, new Set([id]));
        }
      }
    }
    return dependentsByReferenced;
  }

  /**
   * Returns a cached artifact or builds a new one. A cache hit is identified
   * by the dependency closure hash in the artifact directory path, so a
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

    const resolved = await this.resolveClosure(packageId, revision, roomId);
    const depsHash = sha256Hex(
      Buffer.from(JSON.stringify(resolved.sortedClosure), 'utf8'),
    );
    const dir = this.artifactDir(packageId, revision, roomId, depsHash);

    const cached = await this.readManifest(dir);
    if (cached) {
      return cached;
    }

    return this.writeArtifact(dir, resolved);
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

  /**
   * Recursively resolves every cross-package reference starting from the root
   * revision, pinning each dependency to its latest published revision. The
   * whole closure must be valid (same-or-global room, published, referenced
   * files present, no cycles) or the build fails with a 4xx before any bytes
   * are written.
   */
  private async resolveClosure(
    packageId: number,
    revision: number,
    roomId: number,
  ): Promise<ResolvedClosure> {
    const revisionByPackage = new Map<number, number>();
    const textFilesByPackage = new Map<number, PackageTextFile[]>();
    const bytesByPackage = new Map<number, Map<string, Buffer>>();
    const filesByPackage = new Map<number, PackageFileEntry[]>();
    const nameByPackage = new Map<number, string>();
    const publishedAtByPackage = new Map<number, string>();
    const directDependencies: PackageRuntimeDependency[] = [];
    const seenDirectDeps = new Set<number>();
    const visiting: number[] = [];

    const resolvePackage = async (
      id: number,
      exactRevision: number | null,
    ): Promise<void> => {
      if (revisionByPackage.has(id)) {
        return;
      }

      const loaded = await this.loadRevision(id, exactRevision, roomId);
      revisionByPackage.set(id, loaded.revision);
      visiting.push(id);
      nameByPackage.set(id, loaded.name);
      publishedAtByPackage.set(id, loaded.publishedAt);
      filesByPackage.set(id, loaded.files);

      const fileSet = new Set(loaded.files.map((file) => file.filepath));
      const bytes = new Map<string, Buffer>();
      const textFiles: PackageTextFile[] = [];

      for (const entry of loaded.files) {
        const data = await this.readFileBytes(
          id,
          loaded.revision,
          entry.filepath,
        );
        bytes.set(entry.filepath, data);
        if (isTextPackageFile(entry.filepath)) {
          let text: string;
          try {
            text = decodePackageText(entry.filepath, data);
          } catch (error) {
            throw new BadRequestException((error as Error).message);
          }
          textFiles.push({ filepath: entry.filepath, text });
        }
      }
      bytesByPackage.set(id, bytes);
      textFilesByPackage.set(id, textFiles);

      for (const file of textFiles) {
        let references: PackageFileReference[];
        try {
          references = collectPackageReferences(file.text);
        } catch (error) {
          throw new BadRequestException((error as Error).message);
        }
        for (const ref of references) {
          if (ref.packageId === id) {
            if (!fileSet.has(ref.filepath)) {
              throw new BadRequestException(
                `package_dependency_missing_file:${packageId}:${ref.filepath}`,
              );
            }
            continue;
          }

          if (visiting.includes(ref.packageId)) {
            throw new BadRequestException(
              `package_dependency_cycle:${[...visiting, ref.packageId].join('->')}`,
            );
          }

          if (!revisionByPackage.has(ref.packageId)) {
            await resolvePackage(ref.packageId, null);
          }

          const dependencyFiles = filesByPackage.get(ref.packageId)!;
          if (!dependencyFiles.some((f) => f.filepath === ref.filepath)) {
            throw new BadRequestException(
              `package_dependency_missing_file:${ref.packageId}:${ref.filepath}`,
            );
          }

          if (id === packageId && !seenDirectDeps.has(ref.packageId)) {
            seenDirectDeps.add(ref.packageId);
            directDependencies.push({
              packageId: ref.packageId,
              revision: revisionByPackage.get(ref.packageId)!,
              name: nameByPackage.get(ref.packageId)!,
            });
          }
        }
      }

      visiting.pop();
    };

    await resolvePackage(packageId, revision);

    const sortedClosure = [...revisionByPackage.entries()].sort(
      (a, b) => a[0] - b[0],
    );

    return {
      packageId,
      name: nameByPackage.get(packageId)!,
      revision: revisionByPackage.get(packageId)!,
      roomId,
      publishedAt: publishedAtByPackage.get(packageId)!,
      sortedClosure,
      revisionByPackage,
      rootFiles: filesByPackage.get(packageId)!,
      bytes: bytesByPackage.get(packageId)!,
      rootTextFiles: textFilesByPackage.get(packageId)!,
      dependencyTextFiles: this.dependencyTextFiles(
        textFilesByPackage,
        packageId,
      ),
      directDependencies,
    };
  }

  private async loadRevision(
    packageId: number,
    exactRevision: number | null,
    roomId: number,
  ): Promise<LoadedRevision> {
    const row = await this.revisionsRepository.findOne(
      exactRevision !== null
        ? {
            where: { package: { id: packageId }, revision: exactRevision },
            relations: ['package', 'package.room'],
          }
        : {
            where: { package: { id: packageId }, status: 'published' },
            order: { revision: 'DESC' },
            relations: ['package', 'package.room'],
          },
    );

    if (!row || !row.publishedAt) {
      if (exactRevision !== null) {
        throw new NotFoundException(
          `Revision ${exactRevision} of package ${packageId} is not published`,
        );
      }
      throw new BadRequestException(
        `package_dependency_unpublished:${packageId}`,
      );
    }
    if (exactRevision !== null && row.status !== 'published') {
      throw new NotFoundException(
        `Revision ${exactRevision} of package ${packageId} is not published`,
      );
    }

    const room = row.package?.room ?? null;
    if (room && room.id !== roomId) {
      throw new BadRequestException(
        `package_dependency_room_mismatch:${packageId}`,
      );
    }

    return {
      revision: row.revision,
      files: row.files,
      publishedAt: row.publishedAt.toISOString(),
      name: row.package.name,
      room,
    };
  }

  private dependencyTextFiles(
    textFilesByPackage: Map<number, PackageTextFile[]>,
    rootId: number,
  ): Map<number, PackageTextFile[]> {
    const result = new Map<number, PackageTextFile[]>();
    for (const [packageId, files] of textFilesByPackage) {
      if (packageId !== rootId) {
        result.set(packageId, files);
      }
    }
    return result;
  }

  private async readFileBytes(
    packageId: number,
    revision: number,
    filepath: string,
  ): Promise<Buffer> {
    const key = `${packageId}:${revision}:${filepath}`;
    const cached = this.fileBytes.get(key);
    if (cached) {
      return cached;
    }
    const data = await this.storage.readPublishedFile(
      packageId,
      revision,
      filepath,
    );
    if (data.byteLength > this.maxFileCacheBytes) {
      return data;
    }
    while (this.fileCacheBytes + data.byteLength > this.maxFileCacheBytes) {
      const oldestKey = this.fileBytes.keys().next().value as
        | string
        | undefined;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.fileBytes.get(oldestKey)!;
      this.fileBytes.delete(oldestKey);
      this.fileCacheBytes -= oldest.byteLength;
    }
    this.fileBytes.set(key, data);
    this.fileCacheBytes += data.byteLength;
    return data;
  }

  /**
   * Reads the textual files of a revision and collects every cross-package
   * reference they contain. Binary files are skipped. Throws when a file
   * cannot be read or a text file fails to decode, so callers can skip the
   * whole package rather than building a partial reference graph.
   */
  private async collectRevisionReferences(
    packageId: number,
    entry: { revision: number; files: PackageFileEntry[] },
  ): Promise<PackageFileReference[]> {
    const references: PackageFileReference[] = [];
    for (const file of entry.files) {
      if (!isTextPackageFile(file.filepath)) {
        continue;
      }
      const data = await this.readFileBytes(
        packageId,
        entry.revision,
        file.filepath,
      );
      const text = decodePackageText(file.filepath, data);
      references.push(...collectPackageReferences(text));
    }
    return references;
  }

  private artifactDir(
    packageId: number,
    revision: number,
    roomId: number,
    depsHash: string,
  ): string {
    return path.join(
      this.storage.packageRootDir(packageId),
      'runtime',
      String(roomId),
      String(revision),
      depsHash,
    );
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
            )
          : data;
        await mkdir(path.dirname(path.join(staging, entry.filepath)), {
          recursive: true,
        });
        await writeFile(path.join(staging, entry.filepath), rewritten);
        files.push({
          filepath: entry.filepath,
          size: rewritten.byteLength,
          sha256: sha256Hex(rewritten),
        });
      }
      files.sort((a, b) => a.filepath.localeCompare(b.filepath));

      const sceneDependencies = buildSceneDependencies(
        resolved.packageId,
        resolved.rootTextFiles,
        resolved.dependencyTextFiles,
      );
      const manifestBody = {
        packageId: resolved.packageId,
        name: resolved.name,
        revision: resolved.revision,
        roomId: resolved.roomId,
        publishedAt: resolved.publishedAt,
        files,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
        dependencies: resolved.directDependencies,
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
  ): Buffer {
    let rewritten: string;
    try {
      rewritten = rewritePackageReferences(text, { roomId, revisionByPackage });
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return Buffer.from(stripExtResourceUids(filepath, rewritten), 'utf8');
  }
}
