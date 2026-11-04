/**
 * Traversal of the published dependency graph.
 *
 * Four features ask the same question — "which packages does this one actually
 * reach at runtime" — and each used to answer it with its own loop: one
 * `pop()`ed a stack, one `shift()`ed a queue (quadratic), one pre-seeded a
 * queue with a `visit()` closure, and one ran a cursor over the reverse edges.
 * The order decided which dependency a refusal named, so the four disagreed on
 * observable behaviour. This is the single forward walk; callers keep their own
 * policy and error types through `onDiscover`.
 */

import type { Repository } from 'typeorm';
import type { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import type { PackageStorageService } from '../storage/package-storage.service';

/** What one package contributes to the walk. */
export interface PinnedPackage {
  /** Latest published revision, or null when the package has none. */
  revision: number | null;
  /** Dependency ids pinned by that revision, or null when it recorded none. */
  pins: readonly number[] | null;
}

export interface PinClosureOptions {
  /** Published state of one package. */
  load: (packageId: number) => Promise<PinnedPackage>;
  /**
   * Called once per newly discovered dependency before the walk enters it.
   * Returning false leaves the dependency out of the result; throwing aborts
   * the walk and propagates, which is how callers refuse an operation.
   */
  onDiscover?: (packageId: number) => Promise<boolean> | boolean;
  /** Ids the caller has already handled; extended as the walk proceeds. */
  visited?: Set<number>;
}

/**
 * Walks the pin graph breadth-first from `startIds` and returns every package id
 * reached, in discovery order (the seeds first).
 *
 * Width-first ordering is deliberate: the result reads as "nearest dependency
 * first", so a refusal or a log line names the closest cause instead of
 * whichever branch a stack happened to take first.
 */
export async function walkPinnedClosure(
  startIds: Iterable<number>,
  options: PinClosureOptions,
): Promise<number[]> {
  const visited = options.visited ?? new Set<number>();
  const order: number[] = [];
  const queue: number[] = [];
  for (const id of startIds) {
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    order.push(id);
    queue.push(id);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const packageId = queue[cursor];
    const { revision, pins } = await options.load(packageId);
    if (revision === null || pins === null) {
      continue;
    }
    for (const dependencyId of pins) {
      if (visited.has(dependencyId)) {
        continue;
      }
      if (options.onDiscover && !(await options.onDiscover(dependencyId))) {
        continue;
      }
      visited.add(dependencyId);
      order.push(dependencyId);
      queue.push(dependencyId);
    }
  }

  return order;
}

/** The two collaborators a pin lookup needs. Narrowed so a caller can pass a
 * repository double without constructing a full one. */
export interface PinnedPackageDeps {
  /** Latest published revision row of a package, if it has one. */
  latestPublished(packageId: number): Promise<{ revision: number } | null>;
  /** Dependency ids recorded by that revision, or null when it recorded none. */
  readPinnedDependencies(
    packageId: number,
    revision: number,
  ): Promise<Map<number, number> | null>;
}

/**
 * Published state of one package, as `walkPinnedClosure` wants it.
 *
 * Three services ask this question and each used to carry its own copy of the
 * query, which had already drifted: two filtered through the package relation
 * and one did not, so a deleted package answered differently depending on who
 * asked. One loader keeps the answer identical everywhere.
 */
export async function loadPinnedPackage(
  deps: PinnedPackageDeps,
  packageId: number,
): Promise<PinnedPackage> {
  const latest = await deps.latestPublished(packageId);
  if (!latest) {
    return { revision: null, pins: null };
  }
  const pins = await deps.readPinnedDependencies(packageId, latest.revision);
  return { revision: latest.revision, pins: pins ? [...pins.keys()] : null };
}

/** The `load` callback of `walkPinnedClosure`, built from the two collaborators
 * every package service already injects. */
export function pinnedPackageLoader(
  revisions: Pick<Repository<ScriptingPackageRevision>, 'findOne'>,
  storage: Pick<PackageStorageService, 'readPinnedDependencies'>,
): (packageId: number) => Promise<PinnedPackage> {
  return (packageId) =>
    loadPinnedPackage(
      {
        latestPublished: (id) =>
          revisions.findOne({
            where: { package: { id }, status: 'published' },
            order: { revision: 'DESC' },
          }),
        readPinnedDependencies: (id, revision) =>
          storage.readPinnedDependencies(id, revision),
      },
      packageId,
    );
}
