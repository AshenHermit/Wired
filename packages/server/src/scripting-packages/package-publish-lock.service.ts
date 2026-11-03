import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * Serializes byte-moving operations (publication, slug rewrite) for a set of
 * packages.
 *
 * The authoritative guard is a namespace-scoped Postgres advisory lock, so
 * several server instances agree on which package is being written without a
 * new column (`DB_SYNC` would mutate the shared schema). The in-process set is
 * the cheap fast path, and the whole guard when no DataSource is available
 * (unit tests).
 */
@Injectable()
export class PackagePublishLockService {
  private readonly logger = new Logger(PackagePublishLockService.name);
  private readonly publishing = new Set<number>();

  constructor(
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  /**
   * Rejects uploads while another operation verifies or moves this package's
   * bytes.
   */
  async assertNotPublishing(packageId: number): Promise<void> {
    const publishing =
      this.publishing.has(packageId) ||
      (await this.isPublishLockedElsewhere(packageId));
    if (publishing) {
      throw new ConflictException(
        `Package ${packageId} is being published, try again in a moment`,
      );
    }
  }

  /**
   * Runs `fn` while holding the publication lock of every given package.
   *
   * Locks are taken in ascending id order, so two callers sharing packages
   * cannot deadlock; they are released in reverse order, and every lock is
   * released even when `fn` throws. A lock already held by another instance
   * fails the whole call before `fn` runs.
   */
  async runWithPublishLocks<T>(
    packageIds: number[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const ids = [...new Set(packageIds)].sort((a, b) => a - b);
    const held: Array<{ packageId: number; runner: QueryRunner | null }> = [];
    try {
      for (const packageId of ids) {
        const runner = await this.acquirePublishLock(packageId);
        held.push({ packageId, runner });
        this.publishing.add(packageId);
      }
      return await fn();
    } finally {
      for (const entry of [...held].reverse()) {
        this.publishing.delete(entry.packageId);
        await this.releasePublishLock(entry.runner, entry.packageId);
      }
    }
  }

  /** Advisory lock key; `hashtext` maps it to the lock's bigint id. */
  private publishLockKey(packageId: number): string {
    return `wired.package-publish:${packageId}`;
  }

  /**
   * Probes the advisory lock by taking and immediately releasing it: the lock
   * is held exactly while another instance verifies and moves the bytes.
   * A database error must not block uploads, so it counts as "not publishing".
   */
  private async isPublishLockedElsewhere(packageId: number): Promise<boolean> {
    if (!this.dataSource) {
      return false;
    }
    let runner: QueryRunner;
    try {
      runner = this.dataSource.createQueryRunner();
      await runner.connect();
    } catch (error) {
      this.warnLockFailure(packageId, error);
      return false;
    }
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [this.publishLockKey(packageId)],
      )) as Array<{ locked?: boolean }>;
      const acquired = rows[0]?.locked === true;
      if (acquired) {
        await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [
          this.publishLockKey(packageId),
        ]);
      }
      return !acquired;
    } catch (error) {
      this.warnLockFailure(packageId, error);
      return false;
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  /**
   * Takes the cross-instance publication lock. Returns `null` when the lock
   * was taken locally only (no DataSource, or the database is unreachable):
   * the operation keeps working, but only the in-process guard is active.
   * Throws when another instance holds the lock.
   */
  private async acquirePublishLock(
    packageId: number,
  ): Promise<QueryRunner | null> {
    if (!this.dataSource) {
      return null;
    }
    let runner: QueryRunner;
    try {
      runner = this.dataSource.createQueryRunner();
      await runner.connect();
    } catch (error) {
      this.warnLockFailure(packageId, error);
      return null;
    }
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [this.publishLockKey(packageId)],
      )) as Array<{ locked?: boolean }>;
      if (rows[0]?.locked !== true) {
        await runner.release().catch(() => undefined);
        throw new ConflictException(
          `Package ${packageId} is being published, try again in a moment`,
        );
      }
      return runner;
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }
      await runner.release().catch(() => undefined);
      this.warnLockFailure(packageId, error);
      return null;
    }
  }

  private async releasePublishLock(
    runner: QueryRunner | null,
    packageId: number,
  ): Promise<void> {
    if (!runner) {
      return;
    }
    try {
      await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [
        this.publishLockKey(packageId),
      ]);
    } catch (error) {
      this.warnLockFailure(packageId, error);
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private warnLockFailure(packageId: number, error: unknown): void {
    this.logger.warn(
      `Package ${packageId} publication lock is only process-local: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
