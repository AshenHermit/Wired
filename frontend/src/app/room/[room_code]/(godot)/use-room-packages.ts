"use client";

import * as React from "react";
import type {
  PackageRevisionSyncState,
  PackageSyncStatus,
  ScriptingPackage,
} from "@wired-io/shared";
import { getRoomPackages } from "@/api/services/godot-game";
import { createScriptingPackage } from "@/api/services/scripting-packages";
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
  | "local-changes";

export type RoomPackageEntry = {
  packageId: number;
  name: string;
  version: string;
  status: RoomPackageStatus;
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
  notice: string | null;
  error: string | null;
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
  error: string | null;
  actions: Record<number, PackageActionState>;
  actionFor: (packageId: number) => PackageActionState;
  /**
   * Called once the editor reported ready. Waits for the editor plugin bridge
   * in the background and must never delay the editor itself.
   */
  afterEditorStart: (editor: GodotEditorInstance) => void;
  refresh: () => Promise<void>;
  createPackage: (
    name: string,
    authorId: number,
    version?: string,
  ) => Promise<ScriptingPackage>;
  downloadPackage: (
    packageId: number,
    options?: { force?: boolean },
  ) => Promise<void>;
  removePackage: (
    packageId: number,
    options?: { force?: boolean },
  ) => Promise<void>;
  adoptPackage: (packageId: number) => Promise<void>;
  emitPackage: (
    packageId: number,
    options?: { force?: boolean },
  ) => Promise<void>;
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
    super(
      `В пакете ${packageId} есть локальные изменения (${files.length} файл(ов))`,
    );
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
    super(
      `В пакете ${packageId} уже опубликована ревизия ${publishedRevision}, а в редакторе ${
        loadedRevision === null || loadedRevision === 0
          ? "ревизия не загружена"
          : `ревизия ${loadedRevision}`
      }`,
    );
    this.name = "NewerRevisionError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergePackages(
  current: ScriptingPackage[],
  incoming: ScriptingPackage[],
): ScriptingPackage[] {
  let changed = false;
  const result = current.slice();
  for (const pkg of incoming) {
    if (result.some((existing) => existing.id === pkg.id)) continue;
    result.push(pkg);
    changed = true;
  }
  return changed ? result : current;
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
    name: status.name,
    version: "",
    description: "",
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

    let status: RoomPackageStatus = "not-loaded";
    if (loadedState) {
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
      name: pkg.name,
      version: pkg.version,
      status,
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
    throw new Error("Редактор ещё не готов: дождитесь загрузки проекта Godot");
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
};

type RoomPackagesAction =
  | { type: "reset"; packages: ScriptingPackage[] }
  | { type: "merged"; packages: ScriptingPackage[] }
  | { type: "created"; package: ScriptingPackage }
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
      };
    case "merged": {
      const packages = mergePackages(state.packages, action.packages);
      return packages === state.packages ? state : { ...state, packages };
    }
    case "created": {
      const packages = mergePackages(state.packages, [action.package]);
      return packages === state.packages ? state : { ...state, packages };
    }
    case "loaded": {
      const packages = mergePackages(state.packages, action.incoming);
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
  });
  const [statusLoaded, setStatusLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadedRef = React.useRef<Map<number, PackageBaseline>>(new Map());
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
        throw new GodotFsError("Проект Godot ещё не загружен в редактор");
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
            throw new GodotFsError(
              "Файловая система Godot-редактора ещё не готова: дождитесь загрузки проекта",
            );
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
      setError(`Мост редактора недоступен: ${errorMessage(cause)}`);
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
            try {
              if (await files.exists(pkg.id)) present.add(pkg.id);
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
            try {
              fresh.set(pkg.id, await files.snapshot(pkg.id));
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
        setError(
          `Не удалось получить пакеты комнаты: ${errorMessage(cause)}`,
        );
      }
    },
    [dropTransport, filesRef, roomId],
  );

  const refresh = React.useCallback(
    (): Promise<void> => load(true),
    [load],
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
    (
      name: string,
      authorId: number,
      version = "0.1.0",
    ): Promise<ScriptingPackage> =>
      guarded(async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          throw new Error("Укажите имя пакета");
        }
        const files = requireFileSystem(filesRef.current);
        let created: ScriptingPackage;
        try {
          created = await createScriptingPackage({
            name: trimmed,
            version,
            authorId,
            roomId,
          });
        } catch (cause) {
          throw new Error(`Не удалось создать пакет: ${errorMessage(cause)}`);
        }
        try {
          await files.createPackageDir(created.id);
          requestEditorRescan();
        } catch (cause) {
          if (cause instanceof EditorBridgeError) throw cause;
          throw new Error(
            `Пакет создан на сервере, но каталог в редакторе не создан: ${errorMessage(cause)}`,
          );
        }

        loadedRef.current.set(created.id, { revision: 0, files: {} });
        dispatch({ type: "created", package: created });
        setAction(created.id, {
          notice: "Пакет создан. В редакторе появился пустой каталог пакета.",
        });
        await refresh();
        return created;
      }),
    [filesRef, guarded, refresh, roomId, setAction],
  );

  const beginAction = React.useCallback(
    (packageId: number) => {
      if (inFlightRef.current.has(packageId)) {
        throw new Error(`Действие с пакетом ${packageId} уже выполняется`);
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

  const downloadPackage = React.useCallback(
    (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFileSystem(filesRef.current);
          const baseline = loadedRef.current.get(packageId) ?? null;
          const current = await files.snapshot(packageId);
          const changed = baseline
            ? changedPackageFiles(baseline.files, current)
            : Object.keys(current);
          if (!options.force && changed.length > 0) {
            throw new LocalChangesError(packageId, changed);
          }

          const result = await reconcilePackageRevision(packageId, files, null, {
            force: true,
            onProgress: (currentCount, total) =>
              setAction(packageId, {
                progress: { current: currentCount, total },
              }),
          });
          if (result.status === "conflict") {
            throw new Error(
              "опубликованная ревизия не была применена из-за конфликта",
            );
          }
          requestEditorRescan();
          loadedRef.current.set(packageId, {
            revision: result.revision,
            files: result.files,
          });
          setAction(packageId, {
            notice: `Загружена опубликованная ревизия ${result.revision}.`,
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof LocalChangesError) throw cause;
          if (cause instanceof EditorBridgeError) throw cause;
          const message = `Не удалось скачать пакет: ${errorMessage(cause)}`;
          setAction(packageId, { error: message });
          throw new Error(message);
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction],
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
          if (!(await files.exists(packageId))) {
            loadedRef.current.delete(packageId);
            await refresh();
            return;
          }

          const baseline = loadedRef.current.get(packageId) ?? null;
          const current = await files.snapshot(packageId);
          const changed = baseline
            ? changedPackageFiles(baseline.files, current)
            : Object.keys(current);
          if (!options.force && changed.length > 0) {
            throw new LocalChangesError(packageId, changed);
          }

          await files.deletePackage(packageId);
          requestEditorRescan();
          loadedRef.current.delete(packageId);
          setAction(packageId, {
            notice:
              "Пакет убран из редактора. Файлы других пакетов не изменены.",
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof LocalChangesError) throw cause;
          if (cause instanceof EditorBridgeError) throw cause;
          const message = `Не удалось убрать пакет: ${errorMessage(cause)}`;
          setAction(packageId, { error: message });
          throw new Error(message);
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction],
  );

  const adoptPackage = React.useCallback(
    (packageId: number): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFileSystem(filesRef.current);
          if (!(await files.exists(packageId))) {
            throw new Error("каталог пакета не найден в редакторе");
          }
          const snapshot = await files.snapshot(packageId);
          loadedRef.current.set(packageId, { revision: 0, files: snapshot });
          setAction(packageId, {
            notice:
              "Существующий каталог подключён к пакету. Emit опубликует его файлы.",
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof EditorBridgeError) throw cause;
          const message = `Не удалось подключить каталог пакета: ${errorMessage(cause)}`;
          setAction(packageId, { error: message });
          throw new Error(message);
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction],
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
          throw new Error(
            "Пакет не загружен в редактор: Emit доступен только для загруженного пакета",
          );
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

        beginAction(packageId);
        try {
          const result = await publishPackageFiles(
            packageId,
            files,
            (current, total) =>
              setAction(packageId, { progress: { current, total } }),
          );
          const snapshot = await files.snapshot(packageId);
          loadedRef.current.set(packageId, {
            revision: result.revision.revision,
            files: snapshot,
          });
          setAction(packageId, {
            notice: `Опубликована ревизия ${result.revision.revision}: ${result.uploaded} файл(ов).`,
          });
          await refresh();
        } catch (cause) {
          if (cause instanceof NewerRevisionError) throw cause;
          if (cause instanceof EditorBridgeError) throw cause;
          const message = `Не удалось опубликовать пакет: ${errorMessage(cause)}`;
          setAction(packageId, { error: message });
          throw new Error(message);
        } finally {
          endAction(packageId);
        }
      }),
    [beginAction, endAction, filesRef, guarded, refresh, setAction],
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
    downloadPackage,
    removePackage,
    adoptPackage,
    emitPackage,
  };
}
