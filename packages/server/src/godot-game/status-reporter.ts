import { PackageRevisionSyncState, PackageSyncStatus } from '@wired-io/shared';
import { ScriptingPackage } from 'src/database/entities/scripting-package.entity';
import type { SyncRecord, SyncRecordStore } from './sync-record-store';

/**
 * Turns record bookkeeping into the public package status payload: what the
 * runtime applied and how far each authenticated client got.
 *
 * Read-only by design: the reporter never mutates records, so the manifest
 * reconcile stays the only writer of state transitions.
 */
export class StatusReporter {
  constructor(private readonly store: SyncRecordStore) {}

  /** Latest published revision of one package plus its target states. */
  toStatus(
    pkg: ScriptingPackage,
    roomId: string,
    revision: number,
    publishedAt: Date,
  ): PackageSyncStatus {
    const record = this.store.get(roomId, pkg.id);
    const base = {
      packageId: pkg.id,
      name: pkg.name,
      publishedAt: publishedAt.toISOString(),
    };

    if (!record || record.revision !== revision) {
      return {
        ...base,
        revision,
        state: record ? 'stale' : 'published',
        runtime: {
          state: 'pending',
          revision,
          error: null,
          updatedAt: null,
        },
        clients: [],
      };
    }

    const peers = this.store.peersOf(roomId);
    const clients = [...record.clients.entries()]
      .sort(([a], [b]) => a - b)
      .map(([peer, client]) => ({ peer, ...client }));
    return {
      ...base,
      revision: record.revision,
      state: this.aggregateState(record, peers),
      runtime: {
        state: record.runtimeState,
        revision: record.revision,
        error: record.runtimeError,
        updatedAt: record.runtimeUpdatedAt,
      },
      clients,
    };
  }

  /**
   * Aggregates the runtime and client states. A failure anywhere wins; a
   * runtime that has not applied the revision yet is pending/published; once
   * applied, the revision is ready only when every live peer reported ready.
   */
  aggregateState(
    record: SyncRecord,
    peers: ReadonlySet<number>,
  ): PackageRevisionSyncState {
    if (record.runtimeState === 'failed') {
      return 'failed';
    }
    if (
      [...record.clients.entries()].some(
        ([peer, client]) => peers.has(peer) && client.state === 'failed',
      )
    ) {
      return 'failed';
    }
    if (record.runtimeState !== 'applied') {
      return record.dispatchedAt ? 'pending' : 'published';
    }
    if (peers.size > 0) {
      const ready = [...peers].every(
        (peer) => record.clients.get(peer)?.state === 'ready',
      );
      return ready ? 'ready' : 'applied';
    }
    return 'applied';
  }
}
