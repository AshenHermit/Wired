"use client";

import * as React from "react";
import type {
  PackageRevisionSyncState,
  PackageSlugAvailability,
  PackageSyncStatus,
  ScriptingPackage,
  UpdateScriptingPackagePayload,
  WorkshopPackageMetadata,
  WorkshopPackageSummary,
  WorkshopPublishResult,
} from "@wired-io/shared";
import { getRoomPackages } from "@/api/services/godot-game";
import { apiErrorBody } from "@/i18n/api-error";
import type { AppMessage } from "@/i18n/message";
import {
  checkPackageSlugAvailability,
  copyWorkshopPackageToRoom,
  createScriptingPackage,
  deleteScriptingPackage,
  forkPackageToWorkshop,
  publishPackageToWorkshop,
  updateScriptingPackage,
} from "@/api/services/scripting-packages";
import type { GodotEditorInstance } from "./GodotEditorInstance";
import {
  EditorBridgeError,
  createEditorBridgeClient,
  requestEditorRescan,
} from "./editor-bridge";
import {
  GodotFsError,
  createPackageFileSystem,
  type PackageFileSystem,
} from "./godot-packages-fs";
import {
  changedPackageFiles,
  publishPackageFiles,
  reconcilePackageRevision,
  type PackageBaseline,
} from "./package-sync";
import { useEditorBridge } from "./use-editor-bridge";

/** How often the panel checks for a newer published revision. */
const POLL_MS = 10_000;

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
  runtimeState: "pending" | "applied" | "failed" | null;
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

const IDLE_ACTION: PackageActionState = {
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

/**
 * Raised when an explicit package action would replace or delete local files.
 * The panel asks the user for confirmation and repeats the action with
 * `force: true`.
 */
export class LocalChangesError extends Error {
  constructor(
    public readonly packageId: number,
    public readonly files: string[],
  ) {
    super(`local_changes:${packageId}`);
    this.name = "LocalChangesError";
  }
}

/**
 * Raised when Emit would replace a published revision the panel already knows
 * about. The panel asks for confirmation and repeats the action with `force`.
 */
export class NewerRevisionError extends Error {
  constructor(
    public readonly packageId: number,
    public readonly loadedRevision: number | null,
    public readonly publishedRevision: number,
  ) {
    super(`newer_revision:${packageId}`);
    this.name = "NewerRevisionError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The backend refuses to rename a slug that published packages point at. The
 * dialog lists them and repeats the PATCH with `confirmSlugRename: true`.
 */
export class SlugRenameDependentsError extends Error {
  constructor(
    public readonly dependents: { packageId: number; name: string }[],
  ) {
    super("slug_rename_dependents");
    this.name = "SlugRenameDependentsError";
  }
}

/**
 * The backend renamed the package, but the editor directory still has the old
 * name. Nothing is rolled back: the dialog offers `renamePackageDir` as an
 * idempotent retry. The bridge failure is kept as `cause` so the retry can be
 * diagnosed instead of only reporting the slug that failed.
 */
export class PackageDirectoryRenameError extends Error {
  constructor(
    public readonly packageId: number,
    public readonly fromSlug: string,
    public readonly toSlug: string,
    cause: unknown,
  ) {
    super(`package_directory_rename_failed:${fromSlug}`, { cause });
    this.name = "PackageDirectoryRenameError";
  }
}

/**
 * The workshop slug belongs to another author. The panel cannot update that
 * record, so it offers a fork under a new slug instead; the record is carried
 * along so the dialog can name its author and open the fork form.
 */
export class WorkshopSlugTakenError extends Error {
  constructor(
    public readonly slug: string,
    public readonly workshopPackage: WorkshopPackageSummary,
  ) {
    super(`workshop_slug_taken:${slug}`);
    this.name = "WorkshopSlugTakenError";
  }
}

/**
 * A validation failure the user can fix in the create/edit form. The panel
 * renders `appMessage`; `message` stays a diagnostic code.
 */
export class PackagesActionError extends Error {
  constructor(public readonly appMessage: AppMessage) {
    super(appMessage.key);
    this.name = "PackagesActionError";
  }
}

/** A workshop failure that carries both its translated reason and a diagnostic. */
export class WorkshopActionError extends Error {
  constructor(
    public readonly appMessage: AppMessage,
    diagnostic: string,
  ) {
    super(diagnostic);
    this.name = "WorkshopActionError";
  }
}

type WorkshopErrorData = {
  code?: string;
  slug?: string;
  tag?: string;
  message?: string | string[];
  workshopPackage?: WorkshopPackageSummary;
  dependents?: { packageId?: number; name?: string }[];
};

/** The structured body the backend attaches to a workshop conflict. */
function workshopErrorData(error: unknown): WorkshopErrorData | null {
  return apiErrorBody<WorkshopErrorData>(error);
}

/**
 * The workshop actions show a translated reason for the codes a user can act
 * on; every other failure falls back to the shared unexpected error.
 */
function workshopErrorMessage(
  error: unknown,
  fallback: AppMessage = { key: "Errors.unexpected" },
): AppMessage {
  const data = workshopErrorData(error);

  switch (data?.code) {
    case "package_not_published":
      return { key: "Packages.errors.notPublished" };
    case "slug_taken":
      return { key: "Packages.errors.slugTakenWorkshop" };
    case "publish_conflict":
      return { key: "Packages.errors.publishConflict" };
    case "invalid_tags":
      return data.tag
        ? { key: "Packages.errors.invalidTag", values: { tag: data.tag } }
        : { key: "Packages.errors.invalidTags" };
    case "package_dependency_not_global":
      return {
        key: "Packages.errors.dependencyNotGlobal",
        values: { slug: data.slug ?? "" },
      };
    case "package_dependency_unknown_slug":
      return {
        key: "Packages.errors.dependencyUnknownSlug",
        values: { slug: data.slug ?? "" },
      };
  }

  console.error(error);
  return fallback;
}

/** A short, non-translated reason used for thrown errors and console logs. */
function workshopErrorDiagnostic(error: unknown): string {
  const data = workshopErrorData(error);
  if (!data?.code) return "workshop_failed";
  return data.code === "invalid_tags" && data.tag
    ? `invalid_tags:${data.tag}`
    : data.code;
}

/**
 * The backend refuses to delete a package that enabled packages still depend
 * on. Its 409 payload names them, which is far more useful than the generic
 * "Request failed with status code 409".
 */
function deleteConflictMessage(error: unknown): AppMessage | null {
  const data = apiErrorBody<{
    code?: string;
    dependents?: { packageId?: number; name?: string }[];
  }>(error);
  if (data?.code !== "package_has_dependents" || !data.dependents?.length) {
    return null;
  }
  return {
    key: "Packages.errors.deleteConflict",
    values: {
      names: data.dependents
        .map((dependent) => dependent.name ?? `#${dependent.packageId}`)
        .join(", "),
    },
  };
}

/** A workshop action failure: the translated reason plus a diagnostic code. */
function workshopFailure(
  cause: unknown,
  fallback: AppMessage,
  code: string,
): WorkshopActionError {
  return new WorkshopActionError(
    workshopErrorMessage(cause, fallback),
    `${code}:${workshopErrorDiagnostic(cause)}`,
  );
}

function mergePackages(
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
function withoutRemoved(
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
function packageFromStatus(status: PackageSyncStatus): ScriptingPackage {
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
function packageProjectRoot(editor: GodotEditorInstance): string {
  const projectName = editor.projectInfo?.name;
  if (!editor.rootPath || !projectName) return "";
  return `${editor.rootPath}/${projectName}`;
}

function buildEntries(
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
function requireFileSystem(
  files: PackageFileSystem | null,
): PackageFileSystem {
  if (!files) {
    throw new Error("package_fs_not_ready");
  }
  return files;
}

/**
 * Everything the package panel renders is derived from this reducer. Only a
 * load that still owns the newest request may dispatch: the previous
 * implementation mutated a `packagesRef` before checking whether its request
 * was still current, so a stale load could silently change the package list.
 */
type RoomPackagesState = {
  packages: ScriptingPackage[];
  entries: RoomPackageEntry[];
  actions: Record<number, PackageActionState>;
  /** Packages deleted in this session; stale props/polls must not bring them back. */
  removedIds: Set<number>;
  /** Package ids the status endpoint listed on the previous load. */
  remoteIds: Set<number>;
};

type RoomPackagesAction =
  | { type: "reset"; packages: ScriptingPackage[] }
  | { type: "merged"; packages: ScriptingPackage[] }
  | { type: "created"; package: ScriptingPackage }
  | { type: "updated"; package: ScriptingPackage }
  | { type: "removed"; ids: number[] }
  | {
      type: "loaded";
      incoming: ScriptingPackage[];
      remote: Map<number, PackageSyncStatus>;
      baseline: Map<number, PackageBaseline>;
      snapshots: Map<number, Record<string, string>>;
      present: Set<number>;
    }
  | {
      type: "action";
      packageId: number;
      patch: Partial<PackageActionState>;
    };

function roomPackagesReducer(
  state: RoomPackagesState,
  action: RoomPackagesAction,
): RoomPackagesState {
  switch (action.type) {
    case "reset":
      return {
        packages: action.packages,
        entries: [],
        actions: {},
        removedIds: new Set(),
        remoteIds: new Set(),
      };
    case "merged": {
      const packages = withoutRemoved(
        mergePackages(state.packages, action.packages, state.removedIds),
        state.removedIds,
      );
      return packages === state.packages ? state : { ...state, packages };
    }
    case "created": {
      const packages = withoutRemoved(
        mergePackages(state.packages, [action.package], state.removedIds),
        state.removedIds,
      );
      return packages === state.packages ? state : { ...state, packages };
    }
    case "updated": {
      // A PATCH that resolves after an explicit delete must not resurrect the
      // package, and an unknown package has nothing to update.
      if (state.removedIds.has(action.package.id)) return state;
      const index = state.packages.findIndex(
        (pkg) => pkg.id === action.package.id,
      );
      if (index === -1) return state;
      const packages = state.packages.slice();
      packages[index] = action.package;
      // Only metadata fields are copied into the entry: status, revisions,
      // runtime state and local changes stay exactly as they were.
      const hasEntry = state.entries.some(
        (entry) => entry.packageId === action.package.id,
      );
      return {
        ...state,
        packages,
        entries: hasEntry
          ? state.entries.map((entry) =>
              entry.packageId === action.package.id
                ? {
                    ...entry,
                    slug: action.package.slug,
                    name: action.package.name,
                    version: action.package.version,
                    description: action.package.description ?? "",
                    tags: action.package.tags ?? [],
                  }
                : entry,
            )
          : state.entries,
      };
    }
    case "removed": {
      const removed = new Set([...state.removedIds, ...action.ids]);
      return {
        ...state,
        packages: state.packages.filter((pkg) => !removed.has(pkg.id)),
        entries: state.entries.filter((entry) => !removed.has(entry.packageId)),
        removedIds: removed,
      };
    }
    case "loaded": {
      // The status endpoint lists every room package (including disabled and
      // unpublished ones), so a package the server listed before and no
      // longer lists was deleted elsewhere. A package that never appeared in
      // a status response (created locally, a stale prop) is kept.
      const incomingIds = new Set(action.incoming.map((pkg) => pkg.id));
      const dropped = state.packages
        .filter((pkg) => state.remoteIds.has(pkg.id) && !incomingIds.has(pkg.id))
        .map((pkg) => pkg.id);
      const removedIds =
        dropped.length > 0
          ? new Set([...state.removedIds, ...dropped])
          : state.removedIds;
      const packages = withoutRemoved(
        mergePackages(state.packages, action.incoming, removedIds),
        removedIds,
      );
      return {
        ...state,
        packages,
        entries: buildEntries(
          packages,
          action.remote,
          action.baseline,
          action.snapshots,
          action.present,
        ),
        removedIds,
        remoteIds: incomingIds,
      };
    }
    case "action":
      return {
        ...state,
        actions: {
          ...state.actions,
          [action.packageId]: {
            ...IDLE_ACTION,
            ...state.actions[action.packageId],
            ...action.patch,
          },
        },
      };
    default:
      return state;
  }
}

/**
 * Package panel state for one room.
 *
 * Nothing is written into the editor file system automatically: the room's
 * packages are only listed, and a package enters the editor when the user
 * downloads it (or creates a new one). The loaded set intentionally lives in
 * memory only, so a page reload starts from an empty set again.
 *
 * Transport (editor instance, bridge wait, reconnect loop) lives in
 * `useEditorBridge`; this hook owns the package data and the explicit actions.
 */
export function useRoomPackages(
  roomId: number,
  roomPackages: ScriptingPackage[],
): RoomPackagesController {
  const [state, dispatch] = React.useReducer(roomPackagesReducer, {
    packages: roomPackages,
    entries: [],
    actions: {},
    removedIds: new Set<number>(),
    remoteIds: new Set<number>(),
  });
  const [statusLoaded, setStatusLoaded] = React.useState(false);
  const [error, setError] = React.useState<AppMessage | null>(null);

  const loadedRef = React.useRef<Map<number, PackageBaseline>>(new Map());
  /**
   * Slugs of packages created by an action in this tick. The reducer state is
   * only readable after React re-renders, but `addFromWorkshop` and
   * `forkWorkshopPackage` download the copy immediately, so its slug must be
   * addressable before the state mirror catches up.
   */
  const createdSlugsRef = React.useRef<Map<number, string>>(new Map());
  const snapshotsRef = React.useRef<Map<number, Record<string, string>>>(
    new Map(),
  );
  const remoteRef = React.useRef<Map<number, PackageSyncStatus>>(new Map());
  const inFlightRef = React.useRef<Set<number>>(new Set());
  const mountedRef = React.useRef(false);
  const requestRef = React.useRef(0);
  // Read-only mirror for asynchronous loads: the reducer stays the only writer
  // of package state.
  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshRef = React.useRef<() => Promise<void>>(async () => {});

  const transport = useEditorBridge({
    createFiles: (editor, currentEditor) => {
      const projectRoot = packageProjectRoot(editor);
      if (!projectRoot) {
        throw new GodotFsError("godot_project_not_loaded");
      }
      return createPackageFileSystem({
        bridge: createEditorBridgeClient(),
        // Read at write time: the editor instance is recreated when the page
        // restarts the engine, and package writes must reach the live one. The
        // editor can also be reset between a revision download and the write,
        // so a missing engine is a `GodotFsError`, never a raw `TypeError`.
        getEngine: () => {
          const current = currentEditor();
          if (!current?.editor) {
            throw new GodotFsError("godot_fs_not_ready");
          }
          return current.editor;
        },
        projectRoot,
      });
    },
    onConnected: () => {
      void refreshRef.current();
    },
    onTransportError: (cause) => {
      console.error(cause);
      setError({ key: "Errors.bridgeUnavailable" });
    },
    onConnectError: (message) => {
      setError(message);
    },
  });
  const { filesRef, dropTransport, guarded, reset: resetTransport } = transport;

  const setAction = React.useCallback(
    (packageId: number, patch: Partial<PackageActionState>) => {
      dispatch({ type: "action", packageId, patch });
    },
    [],
  );

  const actionFor = React.useCallback(
    (packageId: number): PackageActionState =>
      state.actions[packageId] ?? IDLE_ACTION,
    [state.actions],
  );

  /**
   * The editor directory of a package is named by its slug. A package without
   * a slug cannot be addressed, and falling back to its numeric id would write
   * into a folder that belongs to something else, so every file-system call
   * resolves the slug here instead.
   */
  const slugOf = React.useCallback((packageId: number): string => {
    const pkg = stateRef.current.packages.find((item) => item.id === packageId);
    const slug = pkg?.slug ?? createdSlugsRef.current.get(packageId);
    if (!slug) {
      throw new Error(`package_slug_missing:${packageId}`);
    }
    return slug;
  }, []);

  const load = React.useCallback(
    async (local: boolean): Promise<void> => {
      const request = ++requestRef.current;
      const files = filesRef.current;
      try {
        const status = await getRoomPackages(roomId);
        const remote = new Map(
          status.packages.map((pkg) => [pkg.packageId, pkg]),
        );
        const incoming = status.packages.map(packageFromStatus);

        // `exists` is a bridge round-trip now, so ask once per load for every
        // package the panel knows about and hand the set to `buildEntries`.
        const known = new Map<number, ScriptingPackage>();
        for (const pkg of stateRef.current.packages) known.set(pkg.id, pkg);
        for (const pkg of incoming) known.set(pkg.id, pkg);

        const present = new Set<number>();
        if (files) {
          for (const pkg of known.values()) {
            // Package data is the only source of the slug; there is no id
            // fallback, and an invalid/missing slug is simply not queried.
            if (!pkg.slug) continue;
            try {
              if (await files.exists(pkg.slug)) present.add(pkg.id);
            } catch (cause) {
              if (cause instanceof EditorBridgeError) throw cause;
            }
          }
        }

        // Hashing every package on every poll competes with the editor for
        // CPU. Status polls reuse the last snapshots; local changes are
        // recomputed on open, focus, manual refresh and around explicit actions.
        let snapshots = snapshotsRef.current;
        if (files && local) {
          const fresh = new Map<number, Record<string, string>>();
          for (const pkg of known.values()) {
            if (!pkg.slug) continue;
            try {
              fresh.set(pkg.id, await files.snapshot(pkg.slug));
            } catch (cause) {
              if (cause instanceof EditorBridgeError) throw cause;
              fresh.set(pkg.id, {});
            }
          }
          snapshots = fresh;
        }

        if (!mountedRef.current || request !== requestRef.current) return;
        // Commit the caches only from the load that still owns the request: a
        // superseded response must not leak into later `buildEntries` calls.
        remoteRef.current = remote;
        if (files && local) {
          snapshotsRef.current = snapshots;
        }
        dispatch({
          type: "loaded",
          incoming,
          remote,
          baseline: loadedRef.current,
          snapshots,
          present,
        });
        setStatusLoaded(true);
        setError(null);
      } catch (cause) {
        // A dead bridge is reported even when a newer load already superseded
        // this one: with a 10 s poll and a 60 s call timeout, discarding it
        // would leave every later action hanging on a bridge that is gone.
        if (!mountedRef.current) return;
        if (cause instanceof EditorBridgeError) {
          dropTransport(cause);
          return;
        }
        if (request !== requestRef.current) return;
        console.error(cause);
        setError({ key: "Errors.packagesUnavailable" });
      }
    },
    [dropTransport, filesRef, roomId],
  );

  const refresh = React.useCallback(
    (): Promise<void> => load(true),
    [load],
  );

  /**
   * A slug change moves `packages/<old>` to `packages/<new>`. An existing
   * non-empty target would either be merged into or rejected by the bridge, so
   * the form asks first and the hook refuses before the PATCH.
   */
  const isPackageDirOccupied = React.useCallback(
    async (slug: string): Promise<boolean> => {
      const files = filesRef.current;
      if (!files || !slug) return false;
      if (!(await files.exists(slug))) return false;
      return Object.keys(await files.snapshot(slug)).length > 0;
    },
    [filesRef],
  );

  React.useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Packages created or published by another user enter the list from props.
  React.useEffect(() => {
    dispatch({ type: "merged", packages: roomPackages });
  }, [roomPackages]);

  const roomIdRef = React.useRef(roomId);
  React.useEffect(() => {
    if (roomIdRef.current === roomId) return;
    roomIdRef.current = roomId;
    // An in-flight load belongs to the old room: invalidate it before clearing
    // so it can neither publish stale state nor keep a dead reconnect loop.
    resetTransport();
    requestRef.current += 1;
    loadedRef.current.clear();
    snapshotsRef.current.clear();
    remoteRef.current.clear();
    inFlightRef.current.clear();
    createdSlugsRef.current.clear();
    dispatch({ type: "reset", packages: roomPackages });
    setStatusLoaded(false);
    setError(null);
  }, [resetTransport, roomId, roomPackages]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!transport.fsReady) return;
    const tick = () => {
      if (document.visibilityState === "visible") {
        void load(false);
      }
    };
    const focus = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [transport.fsReady, load, refresh]);

  const createPackage = React.useCallback(
    ({
      name,
      version,
      slug,
    }: {
      name: string;
      version: string;
      slug: string;
    }): Promise<ScriptingPackage> =>
      guarded(async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          throw new PackagesActionError({ key: "Packages.errors.nameRequired" });
        }
        const trimmedSlug = slug.trim();
        if (!trimmedSlug) {
          throw new PackagesActionError({ key: "Packages.errors.slugRequired" });
        }
        const files = requireFileSystem(filesRef.current);
        if (await isPackageDirOccupied(trimmedSlug)) {
          // A leftover folder from a package deleted in another session would
          // silently become this package's content.
          throw new PackagesActionError({
            key: "Packages.errors.dirOccupied",
            values: { slug: trimmedSlug },
          });
        }
        let created: ScriptingPackage;
        try {
          created = await createScriptingPackage({
            slug: trimmedSlug,
            name: trimmed,
            version,
            roomId,
          });
        } catch (cause) {
          console.error(cause);
          throw new PackagesActionError({
            key: "Packages.errors.createFailed",
          });
        }
        try {
          await files.createPackageDir(created.slug);
          requestEditorRescan();
        } catch (cause) {
          if (cause instanceof EditorBridgeError) throw cause;
          console.error(cause);
          throw new PackagesActionError({
            key: "Packages.errors.createDirFailed",
          });
        }

        loadedRef.current.set(created.id, { revision: 0, files: {} });
        dispatch({ type: "created", package: created });
        setAction(created.id, {
          notice: { key: "Packages.notices.created" },
        });
        await refresh();
        return created;
      }),
    [filesRef, guarded, isPackageDirOccupied, refresh, roomId, setAction],
  );

  /**
   * Availability is advisory for the creation, edit and fork forms; the server
   * still rejects a taken slug. Slugs are room-scoped, so the room is part
   * of the question, and the global workshop scope is reported separately.
   */
  const checkSlugAvailability = React.useCallback(
    (
      slug: string,
      targetRoomId: number = roomId,
      excludeId?: number,
    ): Promise<PackageSlugAvailability> =>
      checkPackageSlugAvailability(slug, targetRoomId, excludeId),
    [roomId],
  );

  /**
   * Metadata lives in the room package list only: the editor files, the
   * stored status and the runtime state are untouched. A slug change is the
   * exception — the backend rewrites every stored reference, so the editor
   * directory is renamed to match, after the PATCH succeeded.
   */
  const updatePackageMetadata = React.useCallback(
    async (
      packageId: number,
      patch: UpdateScriptingPackagePayload,
    ): Promise<ScriptingPackage> => {
      const payload: UpdateScriptingPackagePayload = {};
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new Error("package_metadata_empty");
        payload.name = name;
      }
      if (patch.version !== undefined) {
        const version = patch.version.trim();
        if (!version) throw new Error("package_metadata_empty");
        payload.version = version;
      }
      if (patch.slug !== undefined) {
        const slug = patch.slug.trim();
        if (!slug) throw new Error("package_metadata_empty");
        payload.slug = slug;
      }
      if (patch.description !== undefined) {
        payload.description = patch.description.trim();
      }
      if (patch.tags !== undefined) {
        payload.tags = patch.tags;
      }
      if (patch.confirmSlugRename !== undefined) {
        payload.confirmSlugRename = patch.confirmSlugRename;
      }
      if (Object.keys(payload).length === 0) {
        throw new Error("package_metadata_empty");
      }

      const previousSlug = slugOf(packageId);
      const renaming =
        payload.slug !== undefined && payload.slug !== previousSlug;
      if (renaming && (await isPackageDirOccupied(payload.slug!))) {
        // The bridge would merge into or refuse the target folder, and the
        // server rename cannot be undone, so refuse before any request.
        throw new Error("slug_dir_exists");
      }

      let updated: ScriptingPackage;
      try {
        updated = await updateScriptingPackage(packageId, payload);
      } catch (cause) {
        const data = workshopErrorData(cause);
        if (data?.code === "slug_in_use_by_dependents") {
          throw new SlugRenameDependentsError(
            (data.dependents ?? []).map((dependent) => ({
              packageId: dependent.packageId ?? 0,
              name: dependent.name ?? `#${dependent.packageId ?? "?"}`,
            })),
          );
        }
        console.error(cause);
        setAction(packageId, {
          error: { key: "Packages.errors.updateMetadataFailed" },
        });
        throw new Error("package_update_failed");
      }
      dispatch({ type: "updated", package: updated });
      // The slug is addressable before the state mirror re-renders.
      createdSlugsRef.current.set(packageId, updated.slug);

      if (renaming) {
        const files = filesRef.current;
        if (files && (await files.exists(previousSlug))) {
          try {
            await files.renamePackage(previousSlug, updated.slug);
          } catch (cause) {
            if (cause instanceof EditorBridgeError) throw cause;
            throw new PackageDirectoryRenameError(
              packageId,
              previousSlug,
              updated.slug,
              cause,
            );
          }
        }
        // Rescan only once the directory carries its new name.
        requestEditorRescan();
      }

      // A successful retry must not leave the previous failure on the card.
      setAction(packageId, { error: null });
      await refresh();
      return updated;
    },
    [filesRef, isPackageDirOccupied, refresh, setAction, slugOf],
  );

  /** Moves the editor directory after a slug change that already happened. */
  const renamePackageDir = React.useCallback(
    async (
      packageId: number,
      fromSlug: string,
      toSlug: string,
    ): Promise<void> => {
      const files = requireFileSystem(filesRef.current);
      try {
        // Idempotent: a previous attempt may have moved the folder and then
        // failed while syncing. A leftover target directory is not a reason to
        // skip the move: `rename` reuses an empty one and reports
        // `slug_target_not_empty` for a non-empty one.
        if (await files.exists(fromSlug)) {
          await files.renamePackage(fromSlug, toSlug);
        }
      } catch (cause) {
        if (cause instanceof EditorBridgeError) throw cause;
        throw new PackageDirectoryRenameError(
          packageId,
          fromSlug,
          toSlug,
          cause,
        );
      }
      requestEditorRescan();
      setAction(packageId, { error: null });
      await refresh();
    },
    [filesRef, refresh, setAction],
  );

  const beginAction = React.useCallback(
    (packageId: number) => {
      if (inFlightRef.current.has(packageId)) {
        throw new Error(`package_action_in_progress:${packageId}`);
      }
      inFlightRef.current.add(packageId);
      setAction(packageId, {
        busy: true,
        progress: null,
        notice: null,
        error: null,
      });
    },
    [setAction],
  );

  const endAction = React.useCallback(
    (packageId: number) => {
      inFlightRef.current.delete(packageId);
      setAction(packageId, { busy: false, progress: null });
    },
    [setAction],
  );

  /**
   * Reports a failed action on the card and rethrows it as a coded error. The
   * bridge already carries the message the editor wants to show, so its
   * failures pass through untouched.
   */
  const failAction = React.useCallback(
    (
      packageId: number,
      cause: unknown,
      error: AppMessage,
      code: string,
    ): never => {
      if (cause instanceof EditorBridgeError) throw cause;
      console.error(cause);
      setAction(packageId, { error });
      throw new Error(`${code}:${errorMessage(cause)}`);
    },
    [setAction],
  );

  const downloadPackage = React.useCallback(
    (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFileSystem(filesRef.current);
          const slug = slugOf(packageId);
          const baseline = loadedRef.current.get(packageId) ?? null;
          const current = await files.snapshot(slug);
          const changed = baseline
            ? changedPackageFiles(baseline.files, current)
            : Object.keys(current);
          if (!options.force && changed.length > 0) {
            throw new LocalChangesError(packageId, changed);
          }

          const result = await reconcilePackageRevision(
            packageId,
            slug,
            files,
            null,
            {
              force: true,
              onProgress: (currentCount, total) =>
                setAction(packageId, {
                  progress: { current: currentCount, total },
                }),
            },
          );
          if (result.status === "conflict") {
            throw new Error("package_revision_conflict");
          }
          requestEditorRescan();
          loadedRef.current.set(packageId, {
            revision: result.revision,
            files: result.files,
          });
          setAction(packageId, {
            notice: {
              key: "Packages.notices.downloaded",
              values: { revision: result.revision },
            },
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof LocalChangesError) throw cause;
          failAction(
            packageId,
            cause,
            { key: "Packages.errors.downloadFailed" },
            "package_download_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  /**
   * Copies a workshop record into this room. The copy is independent: it keeps
   * the workshop slug (slugs are room-scoped), comes from the server with its
   * published revision, and is downloaded into the editor like any other
   * package. A failed download leaves the copy created and reports why.
   */
  const addFromWorkshop = React.useCallback(
    (workshopPackageId: number): Promise<ScriptingPackage> =>
      guarded(async () => {
        let created: ScriptingPackage;
        try {
          created = await copyWorkshopPackageToRoom(workshopPackageId, roomId);
        } catch (cause) {
          throw workshopFailure(
            cause,
            { key: "Packages.errors.addFromWorkshopFailed" },
            "workshop_add_failed",
          );
        }
        dispatch({ type: "created", package: created });
        createdSlugsRef.current.set(created.id, created.slug);
        await refresh();
        await downloadPackage(created.id).catch(() => undefined);
        // The download writes its own notice, so the reason of the copy is set
        // last to stay visible on the card.
        setAction(created.id, {
          notice: { key: "Packages.notices.addedToRoom" },
        });
        return created;
      }),
    [downloadPackage, guarded, refresh, roomId, setAction],
  );

  /**
   * Publishes the latest published revision of a room package into the global
   * workshop record. It only touches the global record: the room package, its
   * files and its revision stay exactly as they are.
   */
  const publishToWorkshop = React.useCallback(
    (
      packageId: number,
      metadata: WorkshopPackageMetadata = {},
    ): Promise<WorkshopPublishResult> =>
      guarded(async () => {
        try {
          const result = await publishPackageToWorkshop(packageId, metadata);
          setAction(packageId, {
            error: null,
            notice: {
              key:
                result.mode === "created"
                  ? "Packages.notices.published"
                  : "Packages.notices.publishUpdated",
            },
          });
          return result;
        } catch (cause) {
          const data = workshopErrorData(cause);
          if (data?.code === "workshop_slug_taken" && data.workshopPackage) {
            // Not a failure on the card: the dialog turns this into the fork
            // offer instead.
            setAction(packageId, { error: null });
            throw new WorkshopSlugTakenError(
              data.slug ?? slugOf(packageId),
              data.workshopPackage,
            );
          }
          console.error(cause);
          const message = workshopErrorMessage(cause, {
            key: "Packages.errors.publishFailed",
          });
          setAction(packageId, { error: message });
          throw new WorkshopActionError(
            message,
            `workshop_publish_failed:${workshopErrorDiagnostic(cause)}`,
          );
        }
      }),
    [guarded, setAction, slugOf],
  );

  /**
   * Forks a room package under a new slug. The copy stays in the room, keeps
   * the original parent and rewrites its self-references on the server; it is
   * downloaded like any other package, and publishing it is a separate step.
   */
  const forkWorkshopPackage = React.useCallback(
    (packageId: number, slug: string): Promise<ScriptingPackage> =>
      guarded(async () => {
        let created: ScriptingPackage;
        try {
          created = await forkPackageToWorkshop(packageId, slug.trim());
        } catch (cause) {
          throw workshopFailure(
            cause,
            { key: "Packages.errors.forkFailed" },
            "workshop_fork_failed",
          );
        }
        dispatch({ type: "created", package: created });
        createdSlugsRef.current.set(created.id, created.slug);
        await refresh();
        await downloadPackage(created.id).catch(() => undefined);
        setAction(created.id, {
          notice: {
            key: "Packages.notices.forked",
            values: { slug: created.slug },
          },
        });
        return created;
      }),
    [downloadPackage, guarded, refresh, setAction],
  );

  const removePackage = React.useCallback(
    (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFileSystem(filesRef.current);
          const slug = slugOf(packageId);
          if (!(await files.exists(slug))) {
            loadedRef.current.delete(packageId);
            await refresh();
            return;
          }

          const baseline = loadedRef.current.get(packageId) ?? null;
          const current = await files.snapshot(slug);
          const changed = baseline
            ? changedPackageFiles(baseline.files, current)
            : Object.keys(current);
          if (!options.force && changed.length > 0) {
            throw new LocalChangesError(packageId, changed);
          }

          await files.deletePackage(slug);
          requestEditorRescan();
          loadedRef.current.delete(packageId);
          setAction(packageId, {
            notice: { key: "Packages.notices.removedFromEditor" },
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof LocalChangesError) throw cause;
          failAction(
            packageId,
            cause,
            { key: "Packages.errors.removeFailed" },
            "package_remove_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  const setPackageEnabled = React.useCallback(
    (packageId: number, enabled: boolean): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          await updateScriptingPackage(packageId, { enabled });
          setAction(packageId, {
            notice: {
              key: enabled
                ? "Packages.notices.enabled"
                : "Packages.notices.disabled",
            },
          });
          await refresh();
        } catch (cause) {
          failAction(
            packageId,
            cause,
            {
              key: enabled
                ? "Packages.errors.enableFailed"
                : "Packages.errors.disableFailed",
            },
            enabled ? "package_enable_failed" : "package_disable_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, guarded, refresh, setAction],
  );

  const deletePackage = React.useCallback(
    (packageId: number): Promise<void> =>
      guarded(async () => {
        const slug = slugOf(packageId);
        beginAction(packageId);
        try {
          try {
            await deleteScriptingPackage(packageId);
          } catch (cause) {
            console.error(cause);
            setAction(packageId, {
              error: deleteConflictMessage(cause) ?? {
                key: "Packages.errors.deleteFailed",
              },
            });
            throw new Error("package_delete_failed");
          }

          // The editor directory is local state, not the package itself: a
          // failed cleanup must not make the deleted package look present.
          try {
            const files = filesRef.current;
            if (files) {
              await files.deletePackage(slug);
              requestEditorRescan();
            }
          } catch {
            // The editor may be gone; the package is already deleted.
          }
          snapshotsRef.current.delete(packageId);
          loadedRef.current.delete(packageId);
          createdSlugsRef.current.delete(packageId);
          dispatch({ type: "removed", ids: [packageId] });
          setAction(packageId, {
            notice: { key: "Packages.notices.deleted" },
          });
          await refresh();
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  const adoptPackage = React.useCallback(
    (packageId: number): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFileSystem(filesRef.current);
          const slug = slugOf(packageId);
          if (!(await files.exists(slug))) {
            throw new Error("package_directory_missing");
          }
          const snapshot = await files.snapshot(slug);
          loadedRef.current.set(packageId, { revision: 0, files: snapshot });
          setAction(packageId, {
            notice: { key: "Packages.notices.adopted" },
          });
          await refresh();
        } catch (cause) {
          failAction(
            packageId,
            cause,
            { key: "Packages.errors.adoptFailed" },
            "package_adopt_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  const emitPackage = React.useCallback(
    (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> =>
      guarded(async () => {
        const files = requireFileSystem(filesRef.current);
        const baseline = loadedRef.current.get(packageId);
        if (!baseline) {
          throw new Error("package_not_loaded");
        }

        const remote = remoteRef.current.get(packageId);
        if (
          !options.force &&
          remote &&
          remote.revision > baseline.revision
        ) {
          throw new NewerRevisionError(
            packageId,
            baseline.revision,
            remote.revision,
          );
        }

        const slug = slugOf(packageId);
        beginAction(packageId);
        try {
          const result = await publishPackageFiles(
            packageId,
            slug,
            files,
            (current, total) =>
              setAction(packageId, { progress: { current, total } }),
          );
          const snapshot = await files.snapshot(slug);
          loadedRef.current.set(packageId, {
            revision: result.revision.revision,
            files: snapshot,
          });
          setAction(packageId, {
            notice: {
              key: "Packages.notices.emitPublished",
              values: {
                revision: result.revision.revision,
                uploaded: result.uploaded,
              },
            },
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof NewerRevisionError) throw cause;
          failAction(
            packageId,
            cause,
            { key: "Packages.errors.emitFailed" },
            "package_emit_failed",
          );
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction, slugOf],
  );

  return {
    entries: state.entries,
    fsReady: transport.fsReady,
    statusLoaded,
    error,
    actions: state.actions,
    actionFor,
    afterEditorStart: transport.afterEditorStart,
    refresh,
    createPackage,
    checkSlugAvailability,
    isPackageDirOccupied,
    updatePackageMetadata,
    renamePackageDir,
    downloadPackage,
    removePackage,
    setPackageEnabled,
    deletePackage,
    adoptPackage,
    emitPackage,
    addFromWorkshop,
    publishToWorkshop,
    forkWorkshopPackage,
  };
}
