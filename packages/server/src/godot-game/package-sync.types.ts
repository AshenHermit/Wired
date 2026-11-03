/**
 * The narrow contract the scripting-packages module uses to hand a fixed
 * revision to the room runtime. Kept separate from `PackageSyncService` so the
 * storage module does not depend on godot-game implementation details.
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
