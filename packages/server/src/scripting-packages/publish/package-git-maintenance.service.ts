import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorMessage } from 'src/common/errors';
import { AppConfigService } from 'src/config/config.service';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import { PackageGitRepository } from '../storage/git/package-git-repository';
import { PackageStorageService } from '../storage/package-storage.service';
import { PackageGitReconcileService } from './package-git-reconcile.service';
import { PackagePublishLockService } from './package-publish-lock.service';

/**
 * Periodic and on-demand upkeep of the per-package git repositories: finishes
 * interrupted publications, checks connectivity, prunes unreachable objects,
 * restores tags from the database and exports commits back to directories.
 *
 * Maintenance never makes a package unreadable: `fsck` failures are logged and
 * the run continues, because a broken object is better repaired from the
 * database and the legacy directories than hidden by a failed cron job.
 */
@Injectable()
export class PackageGitMaintenanceService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PackageGitMaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: AppConfigService,
    private readonly repo: PackageGitRepository,
    private readonly storage: PackageStorageService,
    private readonly reconcile: PackageGitReconcileService,
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisions: Repository<ScriptingPackageRevision>,
    private readonly locks: PackagePublishLockService,
  ) {}

  onModuleInit(): void {
    if (!this.configService.packages.gitStorage) {
      return;
    }
    this.timer = setInterval(() => {
      void this.maintainAllPackages();
    }, this.configService.packages.gitGcIntervalMs);
    // Never keep the process (or a CLI context) alive just for maintenance.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Reconcile, verify and collect one package's repository. */
  async maintainPackage(packageId: number): Promise<void> {
    await this.locks.runWithPublishLocks([packageId], () =>
      this.maintainPackageLocked(packageId),
    );
  }

  private async maintainPackageLocked(packageId: number): Promise<void> {
    if (!(await this.repo.hasRepo(packageId))) {
      return;
    }
    await this.reconcile.reconcilePackageLocked(packageId);
    try {
      await this.repo.fsck(packageId);
    } catch (error) {
      this.logger.error(
        `git fsck failed for package ${packageId}: ${errorMessage(error)}`,
      );
    }
    await this.repo.gc(packageId, this.configService.packages.gitGcExpire);
  }

  /**
   * Writes every git-backed published revision back to `revisions/<n>/`.
   * Returns the number of exported revisions; legacy revisions are skipped.
   */
  async exportPackage(packageId: number): Promise<number> {
    if (!(await this.repo.hasRepo(packageId))) {
      return 0;
    }
    const rows = await this.revisions.find({
      where: { package: { id: packageId }, status: 'published' },
      order: { revision: 'ASC' },
    });
    let exported = 0;
    for (const row of rows) {
      if (!row.commitSha) {
        continue;
      }
      await this.storage.exportPublishedRevision(
        packageId,
        row.revision,
        row.files,
        row.commitSha,
      );
      exported += 1;
    }
    return exported;
  }

  /**
   * Repairs refs from the database: a published row whose commit exists but
   * whose tag is missing or stale gets its tag back, and tagged drafts are
   * promoted by the regular reconcile pass.
   */
  async repairPackage(packageId: number): Promise<void> {
    await this.locks.runWithPublishLocks([packageId], () =>
      this.repairPackageLocked(packageId),
    );
  }

  private async repairPackageLocked(packageId: number): Promise<void> {
    if (!(await this.repo.hasRepo(packageId))) {
      return;
    }
    try {
      await this.repo.fsck(packageId);
    } catch (error) {
      this.logger.error(
        `git fsck failed for package ${packageId}: ${errorMessage(error)}`,
      );
    }

    const rows = await this.revisions.find({
      where: { package: { id: packageId } },
    });
    for (const row of rows) {
      if (row.status !== 'published' || !row.commitSha) {
        continue;
      }
      const ref = `refs/tags/revisions/${row.revision}`;
      const current = await this.repo.readRef(packageId, ref);
      if (current === row.commitSha) {
        continue;
      }
      const existing = await this.repo.objectExists(packageId, [row.commitSha]);
      if (!existing.has(row.commitSha)) {
        this.logger.error(
          `Commit ${row.commitSha} of package ${packageId} revision ${row.revision} is missing`,
        );
        continue;
      }
      await this.repo.applyRefUpdates(packageId, [
        { ref, oid: row.commitSha, expected: current },
      ]);
    }

    await this.reconcile.reconcilePackageLocked(packageId);
    this.repo.clearTreeCache(packageId);
  }

  private async maintainAllPackages(): Promise<void> {
    try {
      const rows = await this.revisions.find({
        where: { status: 'published' },
        relations: { package: true },
      });
      const packageIds = [...new Set(rows.map((row) => row.package.id))].sort(
        (left, right) => left - right,
      );
      for (const packageId of packageIds) {
        try {
          await this.maintainPackage(packageId);
        } catch (error) {
          // A package locked by a publication (or one broken repository) must
          // not stop the rest of the sweep; the next run retries it.
          this.logger.error(
            `Package ${packageId} maintenance skipped: ${errorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Package git maintenance failed: ${errorMessage(error)}`,
      );
    }
  }
}
