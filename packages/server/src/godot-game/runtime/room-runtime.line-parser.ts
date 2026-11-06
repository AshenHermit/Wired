/**
 * Wire protocol spoken by the Godot room server on stdout/stderr.
 *
 * Kept as a pure function so the runtime service only deals with side effects
 * (registry, leases, logs) and the protocol itself is unit-testable.
 */
export type RuntimeLineEvent =
  | { kind: 'ready'; roomId: string; port: number }
  | { kind: 'auth'; peer: number; roomId: string }
  | { kind: 'player-left'; peer: number }
  | {
      kind: 'packages-applied';
      packageId: number;
      revision: number;
      files: number;
    }
  | {
      kind: 'packages-failed';
      packageId: number;
      revision: number;
      error: string;
    }
  | {
      kind: 'client-packages-ready';
      peer: number;
      packageId: number;
      revision: number;
    }
  | {
      kind: 'client-packages-failed';
      peer: number;
      packageId: number;
      revision: number;
      error: string;
    };

const READY_PATTERN = /^WIRED_SERVER_READY room=(\S+) port=(\d+) bind=(\S+)/;
const AUTH_OK_PATTERN = /^WIRED_AUTH_OK peer=(\d+) player=\d+ room=(\S+)/;
const PLAYER_LEFT_PATTERN = /^WIRED_PLAYER_LEFT peer=(\d+) player=\d+/;
const PACKAGES_APPLIED_PATTERN =
  /^WIRED_PACKAGES_APPLIED package=(\d+) revision=(\d+)(?: artifact=\S+)? files=(\d+)/;
const PACKAGES_FAILED_PATTERN =
  /^WIRED_PACKAGES_SYNC_FAILED package=(\d+) revision=(\d+) (?:error=)?(.*)$/;
const CLIENT_PACKAGES_READY_PATTERN =
  /^WIRED_CLIENT_PACKAGES_READY peer=(\d+) package=(\d+) revision=(\d+)/;
const CLIENT_PACKAGES_FAILED_PATTERN =
  /^WIRED_CLIENT_PACKAGES_FAILED peer=(\d+) package=(\d+) revision=(\d+) (?:error=)?(.*)$/;

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

  const packagesApplied = PACKAGES_APPLIED_PATTERN.exec(line);
  if (packagesApplied) {
    return {
      kind: 'packages-applied',
      packageId: Number(packagesApplied[1]),
      revision: Number(packagesApplied[2]),
      files: Number(packagesApplied[3]),
    };
  }

  const packagesFailed = PACKAGES_FAILED_PATTERN.exec(line);
  if (packagesFailed) {
    return {
      kind: 'packages-failed',
      packageId: Number(packagesFailed[1]),
      revision: Number(packagesFailed[2]),
      error: packagesFailed[3].trim(),
    };
  }

  const clientReady = CLIENT_PACKAGES_READY_PATTERN.exec(line);
  if (clientReady) {
    return {
      kind: 'client-packages-ready',
      peer: Number(clientReady[1]),
      packageId: Number(clientReady[2]),
      revision: Number(clientReady[3]),
    };
  }

  const clientFailed = CLIENT_PACKAGES_FAILED_PATTERN.exec(line);
  if (clientFailed) {
    return {
      kind: 'client-packages-failed',
      peer: Number(clientFailed[1]),
      packageId: Number(clientFailed[2]),
      revision: Number(clientFailed[3]),
      error: clientFailed[4].trim(),
    };
  }

  return null;
}
