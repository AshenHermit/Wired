/**
 * Wire protocol spoken by the Godot room server on stdout/stderr.
 *
 * Kept as a pure function so the runtime service only deals with side effects
 * (registry, leases, logs) and the protocol itself is unit-testable.
 */
export type RuntimeLineEvent =
  | { kind: 'ready'; roomId: string; port: number }
  | { kind: 'auth'; peer: number; roomId: string }
  | { kind: 'player-left'; peer: number };

const READY_PATTERN = /^WIRED_SERVER_READY room=(\S+) port=(\d+) bind=(\S+)/;
const AUTH_OK_PATTERN = /^WIRED_AUTH_OK peer=(\d+) player=\d+ room=(\S+)/;
const PLAYER_LEFT_PATTERN = /^WIRED_PLAYER_LEFT peer=(\d+) player=\d+/;

export function parseRuntimeLine(line: string): RuntimeLineEvent | null {
  const ready = READY_PATTERN.exec(line);
  if (ready) {
    return { kind: 'ready', roomId: ready[1], port: Number(ready[2]) };
  }

  const authOk = AUTH_OK_PATTERN.exec(line);
  if (authOk) {
    return { kind: 'auth', peer: Number(authOk[1]), roomId: authOk[2] };
  }

  const playerLeft = PLAYER_LEFT_PATTERN.exec(line);
  if (playerLeft) {
    return { kind: 'player-left', peer: Number(playerLeft[1]) };
  }

  return null;
}
