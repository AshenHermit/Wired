import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { PackageFileEntry } from '@wired-io/shared';
import { Repository } from 'typeorm';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { errorMessage } from 'src/common/errors';
import { MAX_PACKAGE_FILE_SIZE } from '../storage/package-manifest';
import { packageDependencyError } from '../package-errors';
import {
  collectRawPackageReferences,
  decodePackageText,
  isTextPackageFile,
  PackageFileReference,
  PackageTextFile,
  resolvePackageReferences,
} from './package-runtime-references';
import {
  loadPackageSlugIndex,
  PackageSlugIndex,
  requirePackageSlug,
} from '../storage/package-slug-index';
import { ASSET_BAKE_VERSION } from '../delivery/asset-bake.constants';
import { sha256Hex } from '../storage/package-hash';import { PackageStorageService } from '../storage/package-storage.service';

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
  slug: string;
  room: { id: number } | null;
  commitSha: string | null;
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
  commitByPackage: Map<number, string | null>;
  nameByPackage: Map<number, string>;
  /** package id -> slug, for the artifact path alias of this closure. */
  slugByPackage: Map<number, string>;
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
    private readonly packagesRepository: Pick<
      Repository<ScriptingPackage>,
      'find'
    >,
    /** Changes the artifact key so a pipeline change rebuilds every artifact. */
    private readonly assetBakeVersion: string | number = ASSET_BAKE_VERSION,
  ) {}

  /**
   * Loads the `slug <-> id` index for one resolve/scan operation. The resolver
   * instance is long-lived, so the index is never cached: packages are created
   * and renamed while the server runs.
   */
  private loadSlugIndex(): Promise<PackageSlugIndex> {
    return loadPackageSlugIndex(this.packagesRepository);
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
  ): Promise<DependentRoomPackage[]> {
    const latestByPackage = await this.loadLatestPublishedRevisions();
    const root = latestByPackage.get(packageId);
    if (!root) {
      return [];
    }

    const slugIndex = await this.loadSlugIndex();
    const dependentsByReferenced = await this.buildReverseReferenceGraph(
      latestByPackage,
      slugIndex,
    );

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
    slugIndex: PackageSlugIndex,
  ): Promise<Map<number, Set<number>>> {
    const dependentsByReferenced = new Map<number, Set<number>>();
    for (const [id, entry] of latestByPackage) {
      let references: PackageFileReference[];
      try {
        references = await this.collectRevisionReferences(
          id,
          entry,
          slugIndex,
          entry.roomId ?? null,
        );
      } catch (error) {
        this.logger.warn(
          `Skipping package ${id} during dependent scan: ${errorMessage(
            error,
          )}`,
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
    const builder = new ClosureBuilder({
      rootId: packageId,
      roomId,
      slugIndex: await this.loadSlugIndex(),
      loadRevision: (id, exactRevision) =>
        this.loadRevision(id, exactRevision, roomId),
      readFileBytes: (id, targetRevision, filepath) =>
        this.readFileBytes(id, targetRevision, filepath),
      readFiles: (id, targetRevision, filepaths, commitSha) =>
        this.readFiles(id, targetRevision, filepaths, commitSha),
      readPinnedDependencies: (id, targetRevision) =>
        this.storage.readPinnedDependencies(id, targetRevision),
      computeArtifactKeys: (revisions, references, commits) =>
        this.computeArtifactKeys(revisions, references, commits),
    });
    return builder.run(revision);
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
    commitByPackage: ReadonlyMap<number, string | null> = new Map(),
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
      const payload = [
        ...closure.map(([id, value]) => [
          id,
          commitByPackage.get(id) ?? `legacy:${value}`,
        ]),
        ['asset-bake', this.assetBakeVersion],
      ];
      keys.set(start, sha256Hex(Buffer.from(JSON.stringify(payload), 'utf8')));
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
      throw packageDependencyError(
        'package_dependency_unpublished',
        `Package ${packageId} has no published revision to depend on.`,
        { packageId },
      );
    }
    if (exactRevision !== null && row.status !== 'published') {
      throw new NotFoundException(
        `Revision ${exactRevision} of package ${packageId} is not published`,
      );
    }

    const room = row.package?.room ?? null;
    if (room && room.id !== roomId) {
      throw packageDependencyError(
        'package_dependency_room_mismatch',
        `Package ${packageId} belongs to another room.`,
        { packageId },
      );
    }

    return {
      revision: row.revision,
      files: row.files,
      publishedAt: row.publishedAt.toISOString(),
      name: row.package.name,
      slug: requirePackageSlug(row.package),
      room,
      commitSha: row.commitSha ?? null,
    };
  }

  /**
   * Drops every cached byte of one package so the next resolve reads the files
   * from disk again. Called after a slug rename rewrites revisions in place:
   * the cache key is (package, revision, filepath) and never changes.
   */
  invalidatePackage(packageId: number): void {
    const prefix = `${packageId}:`;
    for (const [key, data] of this.fileBytes) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      this.fileBytes.delete(key);
      this.fileCacheBytes -= data.byteLength;
    }
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
      const oldestKey = this.fileBytes.keys().next().value;
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
   * reference they contain, resolving slugs in the revision's own room. Binary
   * files are skipped. Throws when a file cannot be read or a text file fails
   * to decode, so callers can skip the whole package rather than building a
   * partial reference graph. A reference to an unknown slug is logged and left
   * out of the graph: publication is where that error is reported, since a scan
   * must not fail on one package.
   */
  private async readFiles(
    packageId: number,
    revision: number,
    filepaths: string[],
    commitSha: string | null,
  ): Promise<Map<string, Buffer>> {
    const result = new Map<string, Buffer>();
    const missing: string[] = [];
    for (const filepath of filepaths) {
      const cached = this.fileBytes.get(
        `${packageId}:${revision}:${filepath}`,
      );
      if (cached) {
        result.set(filepath, cached);
      } else {
        missing.push(filepath);
      }
    }
    if (missing.length > 0) {
      const loaded = await this.storage.readPublishedFiles(
        packageId,
        revision,
        missing,
        commitSha,
      );
      for (const filepath of missing) {
        const data = loaded.get(filepath);
        if (!data) {
          throw new NotFoundException(
            `File ${filepath} not found in revision ${revision}`,
          );
        }
        result.set(filepath, data);
        this.cacheFile(packageId, revision, filepath, data);
      }
    }
    const ordered = new Map<string, Buffer>();
    for (const filepath of filepaths) {
      const data = result.get(filepath);
      if (data) {
        ordered.set(filepath, data);
      }
    }
    return ordered;
  }

  private cacheFile(
    packageId: number,
    revision: number,
    filepath: string,
    data: Buffer,
  ): void {
    if (data.byteLength > this.maxFileCacheBytes) {
      return;
    }
    const key = `${packageId}:${revision}:${filepath}`;
    while (
      this.fileCacheBytes + data.byteLength > this.maxFileCacheBytes &&
      this.fileBytes.size > 0
    ) {
      const oldest = this.fileBytes.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      const removed = this.fileBytes.get(oldest);
      this.fileBytes.delete(oldest);
      this.fileCacheBytes -= removed?.byteLength ?? 0;
    }
    this.fileBytes.set(key, data);
    this.fileCacheBytes += data.byteLength;
  }

  private async collectRevisionReferences(
    packageId: number,
    entry: { revision: number; files: PackageFileEntry[] },
    slugIndex: PackageSlugIndex,
    roomId: number | null,
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
      const { resolved, unknown } = resolvePackageReferences(
        collectRawPackageReferences(text),
        slugIndex,
        roomId,
      );
      for (const slug of unknown) {
        this.logger.warn(
          `Skipping unknown package slug "${slug}" referenced by package ${packageId} (${file.filepath})`,
        );
      }
      references.push(...resolved);
    }
    return references;
  }
}

/** What one closure walk needs from the resolver that owns the byte cache. */
interface ClosureBuilderPorts {
  rootId: number;
  roomId: number;
  slugIndex: PackageSlugIndex;
  loadRevision(
    packageId: number,
    exactRevision: number | null,
    roomId: number,
  ): Promise<LoadedRevision>;
  readFileBytes(
    packageId: number,
    revision: number,
    filepath: string,
  ): Promise<Buffer>;
  readFiles(
    packageId: number,
    revision: number,
    filepaths: string[],
    commitSha: string | null,
  ): Promise<Map<string, Buffer>>;
  readPinnedDependencies(
    packageId: number,
    revision: number,
  ): Promise<Map<number, number> | null>;
  computeArtifactKeys(
    revisionByPackage: ReadonlyMap<number, number>,
    referencesByPackage: ReadonlyMap<number, ReadonlySet<number>>,
    commitByPackage: ReadonlyMap<number, string | null>,
  ): Map<number, string>;
}

/**
 * One dependency walk over a single root revision.
 *
 * Every recursion level feeds the same accumulators, so the state belongs on
 * the builder rather than in a closure over a dozen mutable bindings: `run`
 * is the only way in, it returns a fully populated {@link ResolvedClosure},
 * and a half-built walk can never escape.
 */
class ClosureBuilder {
  private readonly revisionByPackage = new Map<number, number>();
  private readonly textFilesByPackage = new Map<number, PackageTextFile[]>();
  private readonly filesByPackage = new Map<number, PackageFileEntry[]>();
  private readonly nameByPackage = new Map<number, string>();
  private readonly slugByPackage = new Map<number, string>();
  private readonly publishedAtByPackage = new Map<number, string>();
  /** package id -> other package ids its files reference directly. */
  private readonly referencesByPackage = new Map<number, Set<number>>();
  private readonly directDependencyIds: number[] = [];
  private readonly seenDirectDeps = new Set<number>();
  /** Packages on the current recursion stack, innermost last. */
  private readonly visiting: number[] = [];
  /** Only the root's bytes are written, so only they are kept in memory. */
  private rootBytes = new Map<string, Buffer>();
  private root: LoadedRevision | null = null;

  private readonly commitByPackage = new Map<number, string | null>();

  constructor(private readonly ports: ClosureBuilderPorts) {}

  /** Resolves `exactRevision` of the root and everything it pulls in. */
  async run(exactRevision: number): Promise<ResolvedClosure> {
    const { rootId, roomId } = this.ports;
    await this.resolvePackage(rootId, exactRevision);

    const root = this.root;
    if (root === null) {
      throw new Error(`closure_root_missing:${rootId}`);
    }

    return {
      packageId: rootId,
      name: root.name,
      revision: root.revision,
      roomId,
      publishedAt: root.publishedAt,
      revisionByPackage: this.revisionByPackage,
      commitByPackage: this.commitByPackage,
      nameByPackage: this.nameByPackage,
      slugByPackage: this.slugByPackage,
      artifactKeys: this.ports.computeArtifactKeys(
        this.revisionByPackage,
        this.referencesByPackage,
        this.commitByPackage,
      ),
      rootFiles: root.files,
      bytes: this.rootBytes,
      rootTextFiles: this.textFilesByPackage.get(rootId) ?? [],
      dependencyTextFiles: this.dependencyTextFiles(),
      directDependencyIds: this.directDependencyIds,
    };
  }

  private async resolvePackage(
    id: number,
    exactRevision: number | null,
  ): Promise<void> {
    if (this.revisionByPackage.has(id)) {
      return;
    }

    const loaded = await this.loadAndRecord(id, exactRevision);
    // Dependencies recorded when *this* revision was published. A pinned
    // closure keeps `(packageId, revision)` deterministic; an older revision
    // without pins falls back to the latest published dependency below.
    const pinned = await this.ports.readPinnedDependencies(id, loaded.revision);
    const { fileSet, references } = await this.readRevision(id, loaded);

    for (const ref of references) {
      await this.linkReference(id, ref, pinned, fileSet);
    }

    this.visiting.pop();
  }

  /** Loads a revision and records the facts every later phase reads. */
  private async loadAndRecord(
    id: number,
    exactRevision: number | null,
  ): Promise<LoadedRevision> {
    const loaded = await this.ports.loadRevision(
      id,
      exactRevision,
      this.ports.roomId,
    );
    this.revisionByPackage.set(id, loaded.revision);
    this.commitByPackage.set(id, loaded.commitSha);
    this.visiting.push(id);
    this.nameByPackage.set(id, loaded.name);
    this.slugByPackage.set(id, loaded.slug);
    this.publishedAtByPackage.set(id, loaded.publishedAt);
    this.filesByPackage.set(id, loaded.files);
    return loaded;
  }

  /**
   * Reads a revision's files and turns their text into cross-package
   * references.
   *
   * Only the root's bytes are kept: a dependency's binary file is served from
   * that package's own artifact and is never rewritten here, so it never
   * enters memory.
   */
  private async readRevision(
    id: number,
    loaded: LoadedRevision,
  ): Promise<{
    fileSet: Set<string>;
    references: PackageFileReference[];
  }> {
    const isRoot = id === this.ports.rootId;
    const bytes = new Map<string, Buffer>();
    const textFiles: PackageTextFile[] = [];
    const candidates = loaded.files.filter(
      (entry) => isRoot || isTextPackageFile(entry.filepath),
    );
    const contents =
      candidates.length > 0
        ? await this.ports.readFiles(
            id,
            loaded.revision,
            candidates.map((entry) => entry.filepath),
            loaded.commitSha,
          )
        : new Map<string, Buffer>();

    for (const entry of candidates) {
      const data = contents.get(entry.filepath);
      if (!data) {
        throw new NotFoundException(
          `File ${entry.filepath} not found in revision ${loaded.revision}`,
        );
      }
      if (isRoot) {
        bytes.set(entry.filepath, data);
      }
      if (isTextPackageFile(entry.filepath)) {
        textFiles.push({
          filepath: entry.filepath,
          text: this.decodeText(entry.filepath, data),
        });
      }
    }

    if (isRoot) {
      this.root = loaded;
      this.rootBytes = bytes;
    }
    this.textFilesByPackage.set(id, textFiles);

    const references: PackageFileReference[] = [];
    for (const file of textFiles) {
      references.push(...this.resolveReferencesOf(id, file));
    }

    return {
      fileSet: new Set(loaded.files.map((file) => file.filepath)),
      references,
    };
  }

  /** Decodes one text file, naming the file when it is not valid text. */
  private decodeText(filepath: string, data: Buffer): string {
    try {
      return decodePackageText(filepath, data);
    } catch (error) {
      throw new BadRequestException(
        {
          code: 'package_file_not_text',
          filepath,
          message: errorMessage(error),
        },
        { cause: error },
      );
    }
  }

  /** References declared by one text file, with unknown slugs refused. */
  private resolveReferencesOf(
    id: number,
    file: PackageTextFile,
  ): PackageFileReference[] {
    const { roomId, slugIndex } = this.ports;
    try {
      const { resolved, unknown } = resolvePackageReferences(
        collectRawPackageReferences(file.text),
        slugIndex,
        roomId,
      );
      if (unknown.length > 0) {
        throw packageDependencyError(
          'package_dependency_unknown_slug',
          `Package "${unknown[0]}" is not available to this room.`,
          { slug: unknown[0] },
        );
      }
      return resolved;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        {
          code: 'package_reference_unreadable',
          filepath: file.filepath,
          message: errorMessage(error),
        },
        { cause: error },
      );
    }
  }

  /** Records one resolved reference and pulls in the package behind it. */
  private async linkReference(
    id: number,
    ref: PackageFileReference,
    pinned: Map<number, number> | null,
    fileSet: ReadonlySet<string>,
  ): Promise<void> {
    if (ref.packageId === id) {
      if (!fileSet.has(ref.filepath)) {
        throw packageDependencyError(
          'package_dependency_missing_file',
          `Package ${id} does not contain ${ref.filepath}, which its own sources reference.`,
          { packageId: id, filepath: ref.filepath },
        );
      }
      return;
    }

    if (this.visiting.includes(ref.packageId)) {
      throw packageDependencyError(
        'package_dependency_cycle',
        'Packages reference each other in a cycle.',
        { cycle: [...this.visiting, ref.packageId].join('->') },
      );
    }

    if (!this.revisionByPackage.has(ref.packageId)) {
      await this.resolvePackage(
        ref.packageId,
        pinned?.get(ref.packageId) ?? null,
      );
    }

    const dependencyFiles = this.filesByPackage.get(ref.packageId);
    if (
      !dependencyFiles ||
      !dependencyFiles.some((file) => file.filepath === ref.filepath)
    ) {
      throw packageDependencyError(
        'package_dependency_missing_file',
        `Package ${ref.packageId} does not contain ${ref.filepath}, which its dependents reference.`,
        { packageId: ref.packageId, filepath: ref.filepath },
      );
    }

    const direct = this.referencesByPackage.get(id);
    if (direct) {
      direct.add(ref.packageId);
    } else {
      this.referencesByPackage.set(id, new Set([ref.packageId]));
    }

    if (id === this.ports.rootId && !this.seenDirectDeps.has(ref.packageId)) {
      this.seenDirectDeps.add(ref.packageId);
      this.directDependencyIds.push(ref.packageId);
    }
  }

  private dependencyTextFiles(): Map<number, PackageTextFile[]> {
    const result = new Map<number, PackageTextFile[]>();
    for (const [packageId, files] of this.textFilesByPackage) {
      if (packageId !== this.ports.rootId) {
        result.set(packageId, files);
      }
    }
    return result;
  }
}
