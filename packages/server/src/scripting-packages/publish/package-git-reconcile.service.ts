import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorMessage } from 'src/common/errors';
import { ScriptingPackageRevision } from 'src/database/entities/scripting-package-revision.entity';
import {
  PackageGitRepository,
  RefUpdate,
} from '../storage/git/package-git-repository';

/**
 * Repairs the git refs of a package after a crash between the database commit
 * and the atomic ref promotion.
 *
 * A publication writes a `refs/pending/publish/<revision>` ref before it
 * commits the row and only then creates the tag, moves `main` and deletes the
 * pending ref in one transaction. A pending ref that matches a published row
 * is therefore the durable record of a commit that must be finished; every
 * other pending ref belongs to a publication that never reached the database
 * and is dropped. A draft row whose tag exists was committed but its status
 * update was lost, so it is promoted from the tag.
 */
@Injectable()
export class PackageGitReconcileService {
  private readonly logger = new Logger(PackageGitReconcileService.name);

  constructor(
    private readonly repo: PackageGitRepository,
    @InjectRepository(ScriptingPackageRevision)
    private readonly revisions: Repository<ScriptingPackageRevision>,
  ) {}

  async reconcilePackage(packageId: number): Promise<void> {
    if (!(await this.repo.hasRepo(packageId))) {
      return;
    }
    await this.finishPendingRefs(packageId);
    await this.promoteTaggedDrafts(packageId);
  }

  private async finishPendingRefs(packageId: number): Promise<void> {
    const refs = await this.repo.listRefs(packageId, 'refs/pending/');
    for (const { ref, oid } of refs) {
      try {
        const revision = Number(ref.split('/').pop());
        if (!Number.isInteger(revision)) {
          await this.deleteRef(packageId, ref, oid);
          continue;
        }
        const row = await this.revisions.findOne({
          where: { package: { id: packageId }, revision },
        });
        if (!row || row.status !== 'published' || row.commitSha !== oid) {
          await this.deleteRef(packageId, ref, oid);
          continue;
        }

        const tagRef = `refs/tags/revisions/${revision}`;
        const mainRef = 'refs/heads/main';
        const [tagOid, mainOid] = await Promise.all([
          this.repo.readRef(packageId, tagRef),
          this.repo.readRef(packageId, mainRef),
        ]);
        const updates: RefUpdate[] = [
          tagOid
            ? { ref: tagRef, oid, expected: tagOid }
            : { ref: tagRef, oid, expected: null },
          mainOid
            ? { ref: mainRef, oid, expected: mainOid }
            : { ref: mainRef, oid, expected: null },
          { ref, delete: true, expected: oid },
        ];
        await this.repo.applyRefUpdates(packageId, updates);
      } catch (error) {
        this.logger.error(
          `Failed to reconcile ${ref} of package ${packageId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private async promoteTaggedDrafts(packageId: number): Promise<void> {
    const rows = await this.revisions.find({
      where: { package: { id: packageId }, status: 'draft' },
    });
    for (const row of rows) {
      if (row.status !== 'draft') {
        continue;
      }
      const oid = await this.repo.readRef(
        packageId,
        `refs/tags/revisions/${row.revision}`,
      );
      if (!oid) {
        continue;
      }
      const publishedAt = await this.repo.commitDate(packageId, oid);
      await this.revisions.update(
        { package: { id: packageId }, revision: row.revision },
        { status: 'published', commitSha: oid, publishedAt },
      );
    }
  }

  private async deleteRef(
    packageId: number,
    ref: string,
    oid: string,
  ): Promise<void> {
    await this.repo.applyRefUpdates(packageId, [
      { ref, delete: true, expected: oid },
    ]);
  }
}
