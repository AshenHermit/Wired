import { Logger } from '@nestjs/common';
import type { SyncRecord } from './sync-record-store';

/** How often pending/failed applications are retried. */
export const RETRY_TICK_MS = 5_000;
/** The first retry waits 10s, the second 20s. */
const RETRY_STEP_MS = 10_000;
const MAX_ATTEMPTS = 3;
/** A runtime that never answers a dispatch is treated as failed. */
const DISPATCH_TIMEOUT_MS = 30_000;

/**
 * Retry policy for dispatches the runtime never confirmed.
 *
 * A dispatch that stays pending past `DISPATCH_TIMEOUT_MS` becomes failed and
 * is retried with a bounded backoff; after `MAX_ATTEMPTS` the record stops
 * retrying until a manifest reconcile resets it.
 */
export class DispatchScheduler {
  private readonly logger = new Logger(DispatchScheduler.name);

  /** Backoff after a failed application; `null` once attempts are exhausted. */
  scheduleRetry(record: SyncRecord, now = Date.now()): void {
    record.nextAttemptAt =
      record.attempts < MAX_ATTEMPTS
        ? now + RETRY_STEP_MS * record.attempts
        : null;
  }

  /**
   * Marks timed-out dispatches failed and re-dispatches the records whose
   * backoff elapsed. Called on every retry tick.
   */
  runDue(
    records: readonly SyncRecord[],
    dispatch: (record: SyncRecord) => boolean,
    now = Date.now(),
  ): void {
    for (const record of records) {
      this.failTimedOut(record, now);
      if (record.nextAttemptAt === null || record.nextAttemptAt > now) {
        continue;
      }
      if (record.attempts >= MAX_ATTEMPTS) {
        record.nextAttemptAt = null;
        continue;
      }
      dispatch(record);
    }
  }

  private failTimedOut(record: SyncRecord, now: number): void {
    if (
      record.runtimeState !== 'pending' ||
      record.dispatchedAt === null ||
      now - Date.parse(record.dispatchedAt) < DISPATCH_TIMEOUT_MS
    ) {
      return;
    }
    record.runtimeState = 'failed';
    record.runtimeError = 'runtime did not confirm the revision in time';
    record.runtimeUpdatedAt = new Date(now).toISOString();
    record.nextAttemptAt = now;
    this.logger.warn(
      `Runtime did not confirm package ${record.packageId} revision ${record.revision} in room ${record.roomId}`,
    );
  }
}
