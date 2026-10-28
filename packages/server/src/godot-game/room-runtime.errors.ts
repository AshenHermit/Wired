export type RoomRuntimeErrorCode =
  | 'config'
  | 'room_not_running'
  | 'room_starting'
  | 'room_stopping'
  | 'start_failed'
  | 'ticket_secret_missing';

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
