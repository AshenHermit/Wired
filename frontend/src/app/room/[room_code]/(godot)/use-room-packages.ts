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
  beforeEditorStart: (editor: GodotEditorInstance) => Promise<void>;
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
  emitPackage: (packageId: number) => Promise<void>;
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

function buildEntries(
  packages: ScriptingPackage[],
  remote: Map<number, PackageSyncStatus>,
  loaded: Map<number, PackageBaseline>,
  snapshots: Map<number, Record<string, string>>,
  files: PackageFileSystem | null,
): RoomPackageEntry[] {
  return packages.map((pkg) => {
    const loadedState = loaded.get(pkg.id) ?? null;
    const remoteState = remote.get(pkg.id) ?? null;
    const snapshot = snapshots.get(pkg.id) ?? {};
    const inEditor = files?.exists(pkg.id) ?? false;
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
  const filesRef = React.useRef<PackageFileSystem | null>(null);
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

  const refresh = React.useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    const files = filesRef.current;
    try {
      const status = await getRoomPackages(roomId);
      const remote = new Map(
        status.packages.map((pkg) => [pkg.packageId, pkg]),
      );

      const snapshots = new Map<number, Record<string, string>>();
      if (files) {
        for (const pkg of packagesRef.current) {
          try {
            snapshots.set(pkg.id, await files.snapshot(pkg.id));
          } catch {
            snapshots.set(pkg.id, {});
          }
        }
      }

      if (!mountedRef.current || request !== requestRef.current) return;
      setEntries(
        buildEntries(packagesRef.current, remote, loadedRef.current, snapshots, files),
      );
      setStatusLoaded(true);
      setError(null);
    } catch (cause) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setError(
        `Не удалось получить пакеты комнаты: ${errorMessage(cause)}`,
      );
    }
  }, [roomId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!fsReady) return;
    const tick = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [fsReady, refresh]);

  const beforeEditorStart = React.useCallback(
    async (editor: GodotEditorInstance): Promise<void> => {
      try {
        filesRef.current = createPackageFileSystem(editor);
        setFsReady(true);
      } catch (cause) {
        // A package problem must not prevent the editor from opening.
        setError(`Пакеты недоступны: ${errorMessage(cause)}`);
        return;
      }
      await refresh();
    },
    [refresh],
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
    async (
      name: string,
      authorId: number,
      version = "0.1.0",
    ): Promise<ScriptingPackage> => {
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
      } catch (cause) {
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
    },
    [refresh, roomId, setAction],
  );

  const downloadPackage = React.useCallback(
    async (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> => {
      const files = requireFs();
      const baseline = loadedRef.current.get(packageId) ?? null;
      const current = await files.snapshot(packageId);
      const changed = baseline
        ? changedPackageFiles(baseline.files, current)
        : Object.keys(current);
      if (!options.force && changed.length > 0) {
        throw new LocalChangesError(packageId, changed);
      }

      setAction(packageId, { busy: true, progress: null, notice: null, error: null });
      try {
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
        loadedRef.current.set(packageId, {
          revision: result.revision,
          files: result.files,
        });
        setAction(packageId, {
          notice: `Загружена опубликованная ревизия ${result.revision}.`,
        });
        await refresh();
      } catch (cause) {
        const message = `Не удалось скачать пакет: ${errorMessage(cause)}`;
        setAction(packageId, { error: message });
        throw new Error(message);
      } finally {
        setAction(packageId, { busy: false, progress: null });
      }
    },
    [refresh, setAction],
  );

  const removePackage = React.useCallback(
    async (
      packageId: number,
      options: { force?: boolean } = {},
    ): Promise<void> => {
      const files = requireFs();
      if (!files.exists(packageId)) {
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

      setAction(packageId, { busy: true, progress: null, notice: null, error: null });
      try {
        await files.deletePackage(packageId);
        await files.sync();
        loadedRef.current.delete(packageId);
        setAction(packageId, {
          notice: "Пакет убран из редактора. Файлы других пакетов не изменены.",
        });
        await refresh();
      } catch (cause) {
        const message = `Не удалось убрать пакет: ${errorMessage(cause)}`;
        setAction(packageId, { error: message });
        throw new Error(message);
      } finally {
        setAction(packageId, { busy: false });
      }
    },
    [refresh, setAction],
  );

  const emitPackage = React.useCallback(
    async (packageId: number): Promise<void> => {
      const files = requireFs();
      if (!loadedRef.current.has(packageId)) {
        throw new Error(
          "Пакет не загружен в редактор: Emit доступен только для загруженного пакета",
        );
      }

      setAction(packageId, { busy: true, progress: null, notice: null, error: null });
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
        const message = `Не удалось опубликовать пакет: ${errorMessage(cause)}`;
        setAction(packageId, { error: message });
        throw new Error(message);
      } finally {
        setAction(packageId, { busy: false, progress: null });
      }
    },
    [refresh, setAction],
  );

  return {
    entries,
    fsReady,
    statusLoaded,
    error,
    actions,
    actionFor,
    beforeEditorStart,
    refresh,
    createPackage,
    downloadPackage,
    removePackage,
    emitPackage,
  };
}
