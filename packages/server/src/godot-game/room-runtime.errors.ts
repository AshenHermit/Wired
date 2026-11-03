import type { GameConnectionErrorCode } from '@wired-io/shared';

/**
 * Lifecycle failures the runtime raises itself. Derived from the shared wire
 * union, so adding a wire code forces this list (and the two records below) to
 * be revisited rather than silently drifting.
 */
export type RoomRuntimeErrorCode = Exclude<
  GameConnectionErrorCode,
  'rate_limited' | 'packages_pending' | 'packages_failed'
>;

/**
 * Explicit lifecycle error. The HTTP layer must translate this into a 4xx/5xx
 * response: a room that failed to start is never reported as ready.
 */
export class RoomRuntimeError extends Error {
  constructor(
    readonly code: RoomRuntimeErrorCode,
    message: string,
    readonly roomId?: string,
    readonly port?: number,
  ) {
    super(message);
    this.name = 'RoomRuntimeError';
  }
}
