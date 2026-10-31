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
  waitForEditorBridge,
} from "./editor-bridge";
import {
  createPackageFileSystem,
  type PackageFileSystem,
} from "./godot-packages-fs";
import {
  changedPackageFiles,
  publishPackageFiles,
  reconcilePackageRevision,
  type PackageBaseline,
} from "./package-sync";

/** How often the panel checks for a newer published revision. */
const POLL_MS = 10_000;

/**
 * How long the panel waits for the editor plugin to register its bridge before
 * it reports the packages as unavailable. The project itself is already
 * usable at that point: the editor starts before the plugin appears.
 */
const BRIDGE_WAIT_MS = 120_000;

/** How often a lost bridge is polled again. */
const RECONNECT_MS = 2_000;

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
 * Package panel state for one room.
 *
 * Nothing is written into the editor file system automatically: the room's
 * packages are only listed, and a package enters the editor when the user
 * downloads it (or creates a new one). The loaded set intentionally lives in
 * memory only, so a page reload starts from an empty set again.
 */
export function useRoomPackages(
  roomId: number,
  roomPackages: ScriptingPackage[],
): RoomPackagesController {
  const [packages, setPackages] = React.useState<ScriptingPackage[]>(
    () => roomPackages,
  );
  const [entries, setEntries] = React.useState<RoomPackageEntry[]>([]);
  const [fsReady, setFsReady] = React.useState(false);
  const [statusLoaded, setStatusLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [actions, setActions] = React.useState<
    Record<number, PackageActionState>
  >({});

  const packagesRef = React.useRef<ScriptingPackage[]>(packages);
  const loadedRef = React.useRef<Map<number, PackageBaseline>>(new Map());
  const snapshotsRef = React.useRef<Map<number, Record<string, string>>>(
    new Map(),
  );
  const remoteRef = React.useRef<Map<number, PackageSyncStatus>>(new Map());
  const inFlightRef = React.useRef<Set<number>>(new Set());
  const filesRef = React.useRef<PackageFileSystem | null>(null);
  const engineRef = React.useRef<GodotEditorInstance | null>(null);
  const reconnectRef = React.useRef<number | null>(null);
  const mountedRef = React.useRef(false);
  const requestRef = React.useRef(0);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    const merged = mergePackages(packagesRef.current, roomPackages);
    if (merged === packagesRef.current) return;
    packagesRef.current = merged;
    setPackages(merged);
  }, [roomPackages]);

  const setAction = React.useCallback(
    (packageId: number, patch: Partial<PackageActionState>) => {
      setActions((previous) => ({
        ...previous,
        [packageId]: {
          ...IDLE_ACTION,
          ...previous[packageId],
          ...patch,
        },
      }));
    },
    [],
  );

  const actionFor = React.useCallback(
    (packageId: number): PackageActionState =>
      actions[packageId] ?? IDLE_ACTION,
    [actions],
  );

  /**
   * A lost bridge is retried until the plugin registers itself again. The
   * interval is owned by a ref, so repeated losses never stack loops.
   */
  const stopReconnectLoop = React.useCallback((): void => {
    if (reconnectRef.current !== null) {
      window.clearInterval(reconnectRef.current);
      reconnectRef.current = null;
    }
  }, []);

  const connectRef = React.useRef<() => void>(() => {});

  const startReconnectLoop = React.useCallback((): void => {
    if (reconnectRef.current !== null) return;
    reconnectRef.current = window.setInterval(() => {
      if (window.__wiredEditorBridge?.request) {
        connectRef.current();
      }
    }, RECONNECT_MS);
  }, []);

  /**
   * Transport loss only: the plugin is gone or silent, so every package action
   * is refused until the bridge answers again. An operation the plugin rejected
   * is a normal per-action failure and never lands here.
   */
  const dropBridge = React.useCallback(
    (cause: unknown): void => {
      filesRef.current = null;
      setFsReady(false);
      setError(`Мост редактора недоступен: ${errorMessage(cause)}`);
      startReconnectLoop();
    },
    [startReconnectLoop],
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
        remoteRef.current = remote;

        let nextPackages = packagesRef.current;
        const added = status.packages
          .filter(
            (pkg) => !nextPackages.some((existing) => existing.id === pkg.packageId),
          )
          .map(packageFromStatus);
        if (added.length > 0) {
          nextPackages = [...nextPackages, ...added];
          packagesRef.current = nextPackages;
        }

        // `exists` is a bridge round-trip now, so ask once per load and hand
        // the resulting set to `buildEntries`.
        const present = new Set<number>();
        if (files) {
          for (const pkg of nextPackages) {
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
          for (const pkg of nextPackages) {
            try {
              fresh.set(pkg.id, await files.snapshot(pkg.id));
            } catch (cause) {
              if (cause instanceof EditorBridgeError) throw cause;
              fresh.set(pkg.id, {});
            }
          }
          snapshots = fresh;
          snapshotsRef.current = fresh;
        }

        if (!mountedRef.current || request !== requestRef.current) return;
        if (added.length > 0) setPackages(nextPackages);
        setEntries(
          buildEntries(
            nextPackages,
            remote,
            loadedRef.current,
            snapshots,
            present,
          ),
        );
        setStatusLoaded(true);
        setError(null);
      } catch (cause) {
        if (!mountedRef.current || request !== requestRef.current) return;
        if (cause instanceof EditorBridgeError) {
          dropBridge(cause);
          return;
        }
        setError(
          `Не удалось получить пакеты комнаты: ${errorMessage(cause)}`,
        );
      }
    },
    [dropBridge, roomId],
  );

  const refresh = React.useCallback(
    (): Promise<void> => load(true),
    [load],
  );

  const roomIdRef = React.useRef(roomId);
  React.useEffect(() => {
    if (roomIdRef.current === roomId) return;
    roomIdRef.current = roomId;
    loadedRef.current.clear();
    snapshotsRef.current.clear();
    remoteRef.current.clear();
    inFlightRef.current.clear();
    filesRef.current = null;
    packagesRef.current = roomPackages;
    setPackages(roomPackages);
    setEntries([]);
    setActions({});
    setFsReady(false);
    setStatusLoaded(false);
    setError(null);
  }, [roomId, roomPackages]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!fsReady) return;
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
  }, [fsReady, load, refresh]);

  /**
   * Connects the package file system to the plugin once it is reachable.
   * Idempotent: the first successful connection wins and the reconnect loop
   * stops. The editor is already usable at this point.
   */
  const connect = React.useCallback((): boolean => {
    if (filesRef.current) {
      stopReconnectLoop();
      return true;
    }
    const editor = engineRef.current;
    if (!editor || !window.__wiredEditorBridge?.request) return false;

    const projectRoot = packageProjectRoot(editor);
    if (!projectRoot) {
      setError("Проект Godot ещё не загружен в редактор: пакеты недоступны");
      return false;
    }
    try {
      filesRef.current = createPackageFileSystem({
        bridge: createEditorBridgeClient(),
        // Read at write time: the editor instance is recreated when the page
        // restarts the engine, and package writes must reach the live one.
        getEngine: () => engineRef.current!.editor,
        projectRoot,
      });
    } catch (cause) {
      // A package problem must not prevent the editor from opening.
      setError(`Пакеты недоступны: ${errorMessage(cause)}`);
      return false;
    }

    stopReconnectLoop();
    setFsReady(true);
    setError(null);
    void refresh();
    return true;
  }, [refresh, stopReconnectLoop]);

  React.useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  React.useEffect(() => () => stopReconnectLoop(), [stopReconnectLoop]);

  /**
   * Runs after the editor reported ready and waits for the plugin bridge in the
   * background, so it never blocks the editor. A plugin that never appears is
   * reported, but the reconnect loop keeps trying.
   */
  const afterEditorStart = React.useCallback(
    (editor: GodotEditorInstance): void => {
      engineRef.current = editor;
      void (async () => {
        try {
          await waitForEditorBridge(BRIDGE_WAIT_MS);
          if (!mountedRef.current) return;
          connect();
        } catch {
          if (!mountedRef.current) return;
          setError("Мост редактора не появился: пакеты недоступны");
          startReconnectLoop();
        }
      })();
    },
    [connect, startReconnectLoop],
  );

  /**
   * Applies the transport policy around one action: only `EditorBridgeError`
   * drops readiness; everything else is the action's own business.
   */
  const guarded = React.useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (cause) {
        if (cause instanceof EditorBridgeError) {
          dropBridge(cause);
        }
        throw cause;
      }
    },
    [dropBridge],
  );

  const requireFs = (): PackageFileSystem => {
    const files = filesRef.current;
    if (!files) {
      throw new Error(
        "Редактор ещё не готов: дождитесь загрузки проекта Godot",
      );
    }
    return files;
  };

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
        const files = requireFs();
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
        const merged = mergePackages(packagesRef.current, [created]);
        packagesRef.current = merged;
        setPackages(merged);
        setAction(created.id, {
          notice: "Пакет создан. В редакторе появился пустой каталог пакета.",
        });
        await refresh();
        return created;
      }),
    [guarded, refresh, roomId, setAction],
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
          const files = requireFs();
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
    [beginAction, endAction, guarded, refresh, setAction],
  );

  const removePackage = React.useCallback(
    (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFs();
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
          await files.sync();
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
    [beginAction, endAction, guarded, refresh, setAction],
  );

  const adoptPackage = React.useCallback(
    (packageId: number): Promise<void> =>
      guarded(async () => {
        beginAction(packageId);
        try {
          const files = requireFs();
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
    [beginAction, endAction, guarded, refresh, setAction],
  );

  const emitPackage = React.useCallback(
    (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> =>
      guarded(async () => {
        const files = requireFs();
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
    [beginAction, endAction, guarded, refresh, setAction],
  );

  return {
    entries,
    fsReady,
    statusLoaded,
    error,
    actions,
    actionFor,
    afterEditorStart,
    refresh,
    createPackage,
    downloadPackage,
    removePackage,
    adoptPackage,
    emitPackage,
  };
}
