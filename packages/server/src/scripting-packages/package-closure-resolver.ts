import {
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PackageFileEntry } from '@wired-io/shared';
import { Repository } from 'typeorm';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { MAX_PACKAGE_FILE_SIZE } from './package-manifest';
import {
  collectPackageReferences,
  decodePackageText,
  isTextPackageFile,
  PackageFileReference,
  PackageTextFile,
} from './package-runtime-references';
import { sha256Hex } from './package-hash';
import { PackageStorageService } from './package-storage.service';

/** One element of the result of `findDependentRoomPackages`. */
export type DependentRoomPackage = {
  packageId: number;
  roomId: number;
  revision: number;
};

/** A published revision as loaded from the database. */
export type LoadedRevision = {
  revision: number;
  files: PackageFileEntry[];
  publishedAt: string;
  name: string;
  room: { id: number } | null;
};

/** A package's latest usable published revision, as seen by the scan. */
export type LatestPublishedRevision = {
  revision: number;
  files: PackageFileEntry[];
  roomId: number | null;
};

/** Everything resolved from raw published files before any bytes are written. */
export type ResolvedClosure = {
  packageId: number;
  name: string;
  revision: number;
  roomId: number;
  publishedAt: string;
  revisionByPackage: Map<number, number>;
  nameByPackage: Map<number, string>;
  /** package id -> artifact key of that package's own resolved closure. */
  artifactKeys: Map<number, string>;
  rootFiles: PackageFileEntry[];
  bytes: Map<string, Buffer>;
  rootTextFiles: PackageTextFile[];
  dependencyTextFiles: Map<number, PackageTextFile[]>;
  directDependencyIds: number[];
};

/**
 * Resolves the dependency closure of a package revision and the reverse
 * (dependent) graph of published packages.
 *
 * Everything here is pure database/disk work with no HTTP concerns: the
 * delivery service turns a {@link ResolvedClosure} into a runtime artifact,
 * while publication uses {@link findDependentRoomPackages} to learn which
 * room runtimes have to be re-dispatched.
 */
export class PackageClosureResolver {
  private readonly logger = new Logger(PackageClosureResolver.name);

  /**
   * Immutable published bytes, memoized so a repeated resolve never re-reads
   * disk. Bounded by total bytes (the per-file limit): oversized buffers are
   * never cached and the oldest entries are evicted first when the cap is
   * reached.
   */
  private readonly fileBytes = new Map<string, Buffer>();
  private fileCacheBytes = 0;
  private readonly maxFileCacheBytes = MAX_PACKAGE_FILE_SIZE;

  constructor(
    private readonly revisionsRepository: Repository<ScriptingPackageRevision>,
    private readonly storage: PackageStorageService,
  ) {}

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
  ): Promise<DependentRoomPackage[]> {
    const latestByPackage = await this.loadLatestPublishedRevisions();
    const root = latestByPackage.get(packageId);
    if (!root) {
      return [];
    }

    const dependentsByReferenced =
      await this.buildReverseReferenceGraph(latestByPackage);

    const result: DependentRoomPackage[] = [];
    const visited = new Set<number>([packageId]);
    // An index instead of `Array#shift()`: shift is O(n) and makes a wide
    // dependent graph quadratic.
    const queue = [packageId];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
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
   * Loads the latest published revision of every package.
   *
   * `DISTINCT ON (package.id)` keeps only the newest published row per
   * package in the database, so a publication does not deserialize the `files`
   * JSONB of every historical revision just to throw all but one away. A
   * package whose newest published row has no `publishedAt` is dropped
   * entirely (the same invariant `loadRevision` enforces), never falling back
   * to an older row.
   */
  async loadLatestPublishedRevisions(): Promise<
    Map<number, LatestPublishedRevision>
  > {
    const revisions = await this.revisionsRepository
      .createQueryBuilder('revision')
      .innerJoinAndSelect('revision.package', 'package')
      .leftJoinAndSelect('package.room', 'room')
      .where('revision.status = :status', { status: 'published' })
      .andWhere('revision.publishedAt IS NOT NULL')
      .distinctOn(['package.id'])
      .orderBy('package.id', 'ASC')
      .addOrderBy('revision.revision', 'DESC')
      .getMany();

    const latestByPackage = new Map<number, LatestPublishedRevision>();
    for (const row of revisions) {
      const id = row.package.id;
      if (latestByPackage.has(id) || !row.publishedAt) {
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
   * Recursively resolves every cross-package reference starting from the root
   * revision. A dependency is pinned to the revision recorded when the
   * revision that references it was published; revisions published before
   * pins existed fall back to their latest published revision.
   *
   * The whole closure must be valid (same-or-global room, published,
   * referenced files present, no cycles) or the build fails with a 4xx before
   * any bytes are written.
   */
  async resolve(
    packageId: number,
    revision: number,
    roomId: number,
  ): Promise<ResolvedClosure> {
    const revisionByPackage = new Map<number, number>();
    const textFilesByPackage = new Map<number, PackageTextFile[]>();
    const filesByPackage = new Map<number, PackageFileEntry[]>();
    const nameByPackage = new Map<number, string>();
    const publishedAtByPackage = new Map<number, string>();
    /** package id -> other package ids its files reference directly. */
    const referencesByPackage = new Map<number, Set<number>>();
    const directDependencyIds: number[] = [];
    const seenDirectDeps = new Set<number>();
    const visiting: number[] = [];
    /** Only the root's bytes are written, so only they are kept in memory. */
    let rootBytes = new Map<string, Buffer>();

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
      // Dependencies recorded when *this* revision was published. A pinned
      // closure keeps `(packageId, revision)` deterministic; an older revision
      // without pins falls back to the latest published dependency below.
      const pinned = await this.storage.readPinnedDependencies(
        id,
        loaded.revision,
      );

      const fileSet = new Set(loaded.files.map((file) => file.filepath));
      const bytes = new Map<string, Buffer>();
      const textFiles: PackageTextFile[] = [];
      const isRoot = id === packageId;

      for (const entry of loaded.files) {
        const wantsText = isTextPackageFile(entry.filepath);
        if (!isRoot && !wantsText) {
          // A dependency's binary file is served from that package's own
          // artifact and is never rewritten here: keep it out of memory.
          continue;
        }
        const data = await this.readFileBytes(
          id,
          loaded.revision,
          entry.filepath,
        );
        if (isRoot) {
          bytes.set(entry.filepath, data);
        }
        if (wantsText) {
          let text: string;
          try {
            text = decodePackageText(entry.filepath, data);
          } catch (error) {
            throw new BadRequestException((error as Error).message);
          }
          textFiles.push({ filepath: entry.filepath, text });
        }
      }
      if (isRoot) {
        rootBytes = bytes;
      }
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
            await resolvePackage(
              ref.packageId,
              pinned?.get(ref.packageId) ?? null,
            );
          }

          const dependencyFiles = filesByPackage.get(ref.packageId)!;
          if (!dependencyFiles.some((f) => f.filepath === ref.filepath)) {
            throw new BadRequestException(
              `package_dependency_missing_file:${ref.packageId}:${ref.filepath}`,
            );
          }

          const direct = referencesByPackage.get(id);
          if (direct) {
            direct.add(ref.packageId);
          } else {
            referencesByPackage.set(id, new Set([ref.packageId]));
          }

          if (id === packageId && !seenDirectDeps.has(ref.packageId)) {
            seenDirectDeps.add(ref.packageId);
            directDependencyIds.push(ref.packageId);
          }
        }
      }

      visiting.pop();
    };

    await resolvePackage(packageId, revision);

    const artifactKeys = this.computeArtifactKeys(
      revisionByPackage,
      referencesByPackage,
    );

    return {
      packageId,
      name: nameByPackage.get(packageId)!,
      revision: revisionByPackage.get(packageId)!,
      roomId,
      publishedAt: publishedAtByPackage.get(packageId)!,
      revisionByPackage,
      nameByPackage,
      artifactKeys,
      rootFiles: filesByPackage.get(packageId)!,
      bytes: rootBytes,
      rootTextFiles: textFilesByPackage.get(packageId)!,
      dependencyTextFiles: this.dependencyTextFiles(
        textFilesByPackage,
        packageId,
      ),
      directDependencyIds,
    };
  }

  /**
   * Computes one stable artifact key per package in the resolved closure.
   *
   * The key is the sha256 of the sorted `(packageId, revision)` list reachable
   * from that package, including itself. A root and every dependency therefore
   * agree on the same key for the same library state, while any transitive
   * publish changes the key of every package above it.
   */
  computeArtifactKeys(
    revisionByPackage: ReadonlyMap<number, number>,
    referencesByPackage: ReadonlyMap<number, ReadonlySet<number>>,
  ): Map<number, string> {
    const keys = new Map<number, string>();
    for (const start of revisionByPackage.keys()) {
      const reachable = new Set<number>([start]);
      const stack = [start];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const referenced of referencesByPackage.get(current) ?? []) {
          if (!reachable.has(referenced)) {
            reachable.add(referenced);
            stack.push(referenced);
          }
        }
      }
      const closure = [...reachable]
        .filter((id) => revisionByPackage.has(id))
        .map((id) => [id, revisionByPackage.get(id)!] as [number, number])
        .sort((a, b) => a[0] - b[0]);
      keys.set(start, sha256Hex(Buffer.from(JSON.stringify(closure), 'utf8')));
    }
    return keys;
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
}
