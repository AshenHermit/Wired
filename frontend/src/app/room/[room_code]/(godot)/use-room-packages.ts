"use client";

import * as React from "react";
import type { PackageSyncStatus, ScriptingPackage } from "@wired-io/shared";
import { getRoomPackages } from "@/api/services/godot-game";
import type { AppMessage } from "@/i18n/message";
import {
  EditorBridgeError,
  createEditorBridgeClient,
} from "./bridge/editor-bridge";
import {
  GodotFsError,
  createPackageFileSystem,
} from "./bridge/godot-packages-fs";
import type { PackageBaseline } from "./bridge/package-sync";
import {
  IDLE_ACTION,
  packageFromStatus,
  packageProjectRoot,
} from "./room-packages/model";
import type {
  PackageActionState,
  RoomPackagesController,
} from "./room-packages/model";
import { roomPackagesReducer } from "./room-packages/reducer";
import { useEditorBridge } from "./use-editor-bridge";
import { usePackageActions } from "./room-packages/use-package-actions";

export type {
  PackageActionState,
  RoomPackageEntry,
  RoomPackagesController,
  RoomPackageStatus,
} from "./room-packages/model";
export {
  LocalChangesError,
  NewerRevisionError,
  PackageDirectoryRenameError,
  PackagesActionError,
  SlugRenameDependentsError,
  WorkshopActionError,
  WorkshopSlugTakenError,
} from "./room-packages/errors";

/** How often the panel checks for a newer published revision. */
const POLL_MS = 10_000;

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
   * only readable after React re-renders, but `copyFromWorkshop` and
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

  /**
   * Reads the room's package list. `rehash` forces a fresh bridge snapshot for
   * every package; without it the cached snapshots from the last rehash are
   * reused, which is what the background poll wants.
   */
  const readPackages = React.useCallback(
    async (rehash: boolean): Promise<void> => {
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
        if (files && rehash) {
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
        if (files && rehash) {
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

  /** Re-reads with a fresh hash of every package directory. */
  const refresh = React.useCallback(
    (): Promise<void> => readPackages(true),
    [readPackages],
  );

  /** Re-reads without re-hashing; the cached snapshots are close enough. */
  const loadStatus = React.useCallback(
    (): Promise<void> => readPackages(false),
    [readPackages],
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
        void loadStatus();
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
  }, [transport.fsReady, loadStatus, refresh]);

  const actions = usePackageActions({
    roomId,
    dispatch,
    guarded,
    refresh,
    isPackageDirOccupied,
    setAction,
    slugOf,
    filesRef,
    loadedRef,
    snapshotsRef,
    remoteRef,
    createdSlugsRef,
    inFlightRef,
  });


  return {
    ...actions,
    entries: state.entries,
    fsReady: transport.fsReady,
    statusLoaded,
    error,
    actions: state.actions,
    actionFor,
    afterEditorStart: transport.afterEditorStart,
    refresh,
    isPackageDirOccupied,
  };
}
