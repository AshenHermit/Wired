/**
 * The narrow contract the scripting-packages module uses to hand a fixed
 * revision to the room runtime. Kept separate from `PackageSyncService` so the
 * storage module does not depend on godot-game implementation details.
 */
export interface PackageRevisionDispatcher {
  /**
   * Notification payload is the package id and revision only. Receivers load
   * the manifest and files over HTTP and verify hashes themselves.
   */
  revisionPublished(packageId: number, revision: number): Promise<void>;
}

export const PACKAGE_REVISION_DISPATCHER = Symbol(
  'PACKAGE_REVISION_DISPATCHER',
);
