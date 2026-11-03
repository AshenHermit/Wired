import type {
  PackageRevisionSyncState,
  PackageSlugAvailability,
  PackageSyncStatus,
  ScriptingPackage,
  WorkshopPackageMetadata,
  WorkshopPublishResult,
} from "@wired-io/shared";
import type { AppMessage } from "@/i18n/message";
import type { GodotEditorInstance } from "../GodotEditorInstance";
import type { PackageFileSystem } from "../bridge/godot-packages-fs";
import { changedPackageFiles } from "../bridge/package-sync";
import type { PackageBaseline } from "../bridge/package-sync";

export type RoomPackageStatus =
  | "not-loaded"
  | "loaded"
  | "new-revision"
  | "local-changes"
  | "disabled";

export type RoomPackageEntry = {
  packageId: number;
  /** The editor directory of the package is `packages/<slug>`. */
  slug: string;
  name: string;
  version: string;
  /** Shown read-only on the card; edited in the package dialog. */
  description: string;
  tags: string[];
  status: RoomPackageStatus;
  /** The package is active in the room runtime. */
  enabled: boolean;
  /** Loaded by an explicit action in this editor session. */
  loaded: boolean;
  /** The package directory is present in the editor FS. */
  inEditor: boolean;
  publishedRevision: number | null;
  loadedRevision: number | null;
  publishedAt: string | null;
  localChanges: string[];
  backendState: PackageRevisionSyncState | null;
  runtimeState: PackageRevisionSyncState | null;
  runtimeError: string | null;
  clientsReady: number;
  clientsTotal: number;
};

export type PackageActionState = {
  busy: boolean;
  progress: { current: number; total: number } | null;
  notice: AppMessage | null;
  error: AppMessage | null;
};

export const IDLE_ACTION: PackageActionState = {
  busy: false,
  progress: null,
  notice: null,
  error: null,
};

export type RoomPackagesController = {
  entries: RoomPackageEntry[];
  fsReady: boolean;
  statusLoaded: boolean;
  error: AppMessage | null;
  actions: Record<number, PackageActionState>;
  actionFor: (packageId: number) => PackageActionState;
  /**
   * Called once the editor reported ready. Waits for the editor plugin bridge
   * in the background and must never delay the editor itself.
   */
  afterEditorStart: (editor: GodotEditorInstance) => void;
  refresh: () => Promise<void>;
  createPackage: (draft: {
    name: string;
    version: string;
    slug: string;
  }) => Promise<ScriptingPackage>;
  /** Asks the backend whether a new package may use this slug. */
  checkSlugAvailability: (
    slug: string,
    roomId?: number,
    excludeId?: number,
  ) => Promise<PackageSlugAvailability>;
  /**
   * Updates the package metadata on the backend. A slug change also renames the
   * editor directory and rewrites every reference the server stored.
   */
  updatePackageMetadata: (
    packageId: number,
    patch: {
      name?: string;
      version?: string;
      slug?: string;
      description?: string;
      tags?: string[];
      confirmSlugRename?: boolean;
    },
  ) => Promise<ScriptingPackage>;
  /** Whether `packages/<slug>` already exists in the editor with files. */
  isPackageDirOccupied: (slug: string) => Promise<boolean>;
  /** Retries the directory move after a bridge failure; idempotent. */
  renamePackageDir: (
    packageId: number,
    fromSlug: string,
    toSlug: string,
  ) => Promise<void>;
  downloadPackage: (
    packageId: number,
    options?: { force?: boolean },
  ) => Promise<void>;
  removePackage: (
    packageId: number,
    options?: { force?: boolean },
  ) => Promise<void>;
  /** Activates or deactivates the package in the room without deleting it. */
  setPackageEnabled: (packageId: number, enabled: boolean) => Promise<void>;
  /** Deletes the package from the room and the backend, permanently. */
  deletePackage: (packageId: number) => Promise<void>;
  adoptPackage: (packageId: number) => Promise<void>;
  emitPackage: (
    packageId: number,
    options?: { force?: boolean },
  ) => Promise<void>;
  /** Copies a workshop record into the room and downloads the copy. */
  addFromWorkshop: (workshopPackageId: number) => Promise<ScriptingPackage>;
  /** Publishes the latest published revision into the global workshop record. */
  publishToWorkshop: (
    packageId: number,
    metadata?: WorkshopPackageMetadata,
  ) => Promise<WorkshopPublishResult>;
  /** Creates a room copy under a new slug; publishing it is a separate step. */
  forkWorkshopPackage: (
    packageId: number,
    slug: string,
  ) => Promise<ScriptingPackage>;
};

export function mergePackages(
  current: ScriptingPackage[],
  incoming: ScriptingPackage[],
  removedIds: ReadonlySet<number> = new Set(),
): ScriptingPackage[] {
  let changed = false;
  const result = current.slice();
  for (const pkg of incoming) {
    if (removedIds.has(pkg.id)) continue;
    if (result.some((existing) => existing.id === pkg.id)) continue;
    result.push(pkg);
    changed = true;
  }
  return changed ? result : current;
}

/**
 * A package can never come back after an explicit delete in this session, even
 * when the room prop or a slow poll still carries it.
 */
export function withoutRemoved(
  packages: ScriptingPackage[],
  removedIds: ReadonlySet<number>,
): ScriptingPackage[] {
  if (removedIds.size === 0) return packages;
  const kept = packages.filter((pkg) => !removedIds.has(pkg.id));
  return kept.length === packages.length ? packages : kept;
}

/**
 * A package can be created and published by another user while this editor is
 * open. The room prop is a snapshot, so such packages enter the list from the
 * status endpoint. Only its name and published revision are known here.
 */
export function packageFromStatus(status: PackageSyncStatus): ScriptingPackage {
  const timestamp = status.publishedAt ?? "";
  return {
    id: status.packageId,
    slug: status.slug,
    name: status.name,
    version: "",
    description: "",
    tags: [],
    enabled: status.enabled,
    dependencies: [],
    scripts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * The editor keeps the project under its persistent root, and the packages
 * live inside the project: `<rootPath>/<project name>/packages/<id>`. This is
 * the same root the old Emscripten-FS implementation derived from the editor
 * instance.
 */
export function packageProjectRoot(editor: GodotEditorInstance): string {
  const projectName = editor.projectInfo?.name;
  if (!editor.rootPath || !projectName) return "";
  return `${editor.rootPath}/${projectName}`;
}

export function buildEntries(
  packages: ScriptingPackage[],
  remote: Map<number, PackageSyncStatus>,
  loaded: Map<number, PackageBaseline>,
  snapshots: Map<number, Record<string, string>>,
  present: Set<number>,
): RoomPackageEntry[] {
  return packages.map((pkg) => {
    const loadedState = loaded.get(pkg.id) ?? null;
    const remoteState = remote.get(pkg.id) ?? null;
    const snapshot = snapshots.get(pkg.id) ?? {};
    // `exists` is an asynchronous bridge call now, so `load` awaits it for
    // every package and passes the resulting set here.
    const inEditor = present.has(pkg.id);
    const localChanges = loadedState
      ? changedPackageFiles(loadedState.files, snapshot)
      : Object.keys(snapshot);

    const enabled = remoteState?.enabled ?? pkg.enabled !== false;

    let status: RoomPackageStatus = "not-loaded";
    if (!enabled) {
      // A disabled package keeps its local files and changes visible, but it
      // is not part of the room runtime, so download/emit are not offered.
      status = "disabled";
    } else if (loadedState) {
      if (localChanges.length > 0) {
        status = "local-changes";
      } else if (
        remoteState &&
        remoteState.revision > loadedState.revision
      ) {
        status = "new-revision";
      } else {
        status = "loaded";
      }
    } else if (inEditor && localChanges.length > 0) {
      status = "local-changes";
    }

    const publishedRevision = remoteState?.revision ?? null;
    const loadedRevision = loadedState?.revision ?? null;

    return {
      packageId: pkg.id,
      slug: pkg.slug,
      name: pkg.name,
      version: pkg.version,
      description: pkg.description ?? "",
      tags: pkg.tags ?? [],
      status,
      enabled,
      loaded: loadedState !== null,
      inEditor,
      publishedRevision,
      loadedRevision,
      publishedAt: remoteState?.publishedAt ?? null,
      localChanges,
      backendState: remoteState?.state ?? null,
      runtimeState: remoteState?.runtime.state ?? null,
      runtimeError: remoteState?.runtime.error ?? null,
      clientsReady:
        remoteState?.clients.filter((client) => client.state === "ready")
          .length ?? 0,
      clientsTotal: remoteState?.clients.length ?? 0,
    };
  });
}

/**
 * Every explicit action needs a connected package file system. The editor may
 * not be ready yet when the panel renders, so this is reported as a plain
 * error instead of a nullable type leaking into each action.
 */
export function requireFileSystem(
  files: PackageFileSystem | null,
): PackageFileSystem {
  if (!files) {
    throw new Error("package_fs_not_ready");
  }
  return files;
}
