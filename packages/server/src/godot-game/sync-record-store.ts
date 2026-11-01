/**
 * In-memory bookkeeping for dispatched package revisions.
 *
 * This is deliberately not a delivery guarantee: the published manifest stays
 * the source of truth, and every record here is a hint that can be rebuilt by
 * reconciling manifests. Keeping the store separate from the reconciler means
 * a backend restart loses only timing information, and the state shape stays
 * in one place instead of being spread over the service.
 */
export type RuntimeState = 'pending' | 'applied' | 'failed';
export type ClientState = 'pending' | 'ready' | 'failed';

export interface ClientSyncRecord {
  state: ClientState;
  revision: number;
  error: string | null;
  updatedAt: string;
}

export interface SyncRecord {
  roomId: string;
  packageId: number;
  revision: number;
  runtimeState: RuntimeState;
  runtimeError: string | null;
  runtimeUpdatedAt: string | null;
  dispatchedAt: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  clients: Map<number, ClientSyncRecord>;
}

export class SyncRecordStore {
  private readonly recordsByKey = new Map<string, SyncRecord>();
  private readonly peersByRoom = new Map<string, Set<number>>();

  /** Key of one room/package pair; the same tuple the runtime is dispatched to. */
  static key(roomId: string, packageId: number): string {
    return `${roomId}:${packageId}`;
  }

  get(roomId: string, packageId: number): SyncRecord | undefined {
    return this.recordsByKey.get(SyncRecordStore.key(roomId, packageId));
  }

  /** Creates a record for a never-seen revision and stores it. */
  create(roomId: string, packageId: number, revision: number): SyncRecord {
    const record: SyncRecord = {
      roomId,
      packageId,
      revision,
      runtimeState: 'pending',
      runtimeError: null,
      runtimeUpdatedAt: null,
      dispatchedAt: null,
      attempts: 0,
      nextAttemptAt: null,
      clients: new Map(),
    };
    this.recordsByKey.set(SyncRecordStore.key(roomId, packageId), record);
    return record;
  }

  /** Every tracked record, across rooms. */
  all(): SyncRecord[] {
    return [...this.recordsByKey.values()];
  }

  /** Records of one room, in insertion order. */
  forRoom(roomId: string): SyncRecord[] {
    return this.all().filter((record) => record.roomId === roomId);
  }

  /** Forgets runtime confirmations and client states before a fresh dispatch. */
  resetForDispatch(record: SyncRecord): void {
    record.attempts = 0;
    record.nextAttemptAt = null;
    record.runtimeState = 'pending';
    record.runtimeError = null;
    record.runtimeUpdatedAt = null;
    record.dispatchedAt = null;
    record.clients.clear();
  }

  /** Mutable peer set of a room; creates it on first use. */
  peers(roomId: string): Set<number> {
    let peers = this.peersByRoom.get(roomId);
    if (!peers) {
      peers = new Set<number>();
      this.peersByRoom.set(roomId, peers);
    }
    return peers;
  }

  /** Read-only view that does not create an entry for an unknown room. */
  peersOf(roomId: string): ReadonlySet<number> {
    return this.peersByRoom.get(roomId) ?? EMPTY_PEERS;
  }

  /**
   * Drops every peer of a room. A restarted runtime has no connected clients:
   * peers of the previous process never sent `player_left` and must not gate
   * the aggregate status.
   */
  forgetPeers(roomId: string): void {
    this.peersByRoom.delete(roomId);
  }

  removePeer(roomId: string, peer: number): void {
    this.peersByRoom.get(roomId)?.delete(peer);
  }
}

const EMPTY_PEERS: ReadonlySet<number> = new Set<number>();
