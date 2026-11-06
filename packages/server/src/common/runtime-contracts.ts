import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Contracts that cross a module boundary.
 *
 * The package module hands revisions to the room runtime and the runtime reads
 * packages back over HTTP, so both directions are described here instead of in
 * either feature folder. Keeping them neutral is what keeps the TypeScript
 * import graph acyclic: whoever owns one side can be moved without touching
 * the other.
 *
 * The Nest module graph still crosses both ways — `ScriptingPackagesModule`
 * imports `GodotGameModule` to receive the dispatcher binding, and
 * `GodotGameModule` imports `PackageDeliveryModule` — so the two module files
 * are still edited together. Only the imports are neutral here, not the wiring.
 */

/**
 * The narrow contract the scripting-packages module uses to hand a fixed
 * revision to the room runtime.
 */
export interface PackageRevisionDispatcher {
  /**
   * Notification payload is the package id and revision only. Receivers load
   * the manifest and files over HTTP and verify hashes themselves. A
   * publication also refreshes the room packages that depend on the published
   * one, since their runtime artifacts embed its bytes.
   */
  revisionPublished(packageId: number, revision: number): Promise<void>;

  /**
   * Re-dispatches packages whose published files changed without a new
   * revision: a slug rename rewrites the renamed package and every dependent in
   * place. Clients re-fetch the same revision, which is a normal dependent
   * refresh.
   */
  packagesChanged(packageIds: number[]): Promise<void>;

  /**
   * Applies a new `enabled` flag: disabling unloads the package from the room
   * runtime, enabling reconciles its latest published revision back in.
   */
  packageEnabledChanged(packageId: number): Promise<void>;

  /** Removes a deleted package from the room runtime and deletes its files. */
  packageRemoved(packageId: number, roomId: number): void;
}

export const PACKAGE_REVISION_DISPATCHER = Symbol(
  'PACKAGE_REVISION_DISPATCHER',
);

/**
 * Room-scoped credential for the native Godot runtime.
 *
 * Package manifests and artifacts are served to the runtime over HTTP, but the
 * runtime has no user account. Instead of leaving those routes public, the
 * backend injects a token derived from the game ticket secret and bound to the
 * room: a leaked token cannot read another room's packages.
 *
 * The token is static for the lifetime of a room runtime and never reaches the
 * browser.
 */
const TOKEN_PREFIX = 'runtime-api:v1';

export function createRuntimeServiceToken(
  secret: string,
  roomId: string | number,
): string {
  return createHmac('sha256', secret)
    .update(`${TOKEN_PREFIX}:${roomId}`)
    .digest('hex');
}

/** Accepts an `Authorization: Bearer <token>` header value. */
export function verifyRuntimeServiceToken(
  secret: string,
  roomId: string | number,
  authorization: string | undefined,
): boolean {
  if (!secret || !authorization) {
    return false;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) {
    return false;
  }
  const expected = Buffer.from(createRuntimeServiceToken(secret, roomId));
  const actual = Buffer.from(match[1]);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
