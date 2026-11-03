"use client";

import * as React from "react";
import type { AppMessage } from "@/i18n/message";
import type { GodotEditorInstance } from "./GodotEditorInstance";
import {
  EditorBridgeError,
  EditorBridgeWaitCancelledError,
  waitForEditorBridge,
} from "./bridge/editor-bridge";
import type { PackageFileSystem } from "./bridge/godot-packages-fs";

/**
 * How long the panel waits for the editor plugin to register its bridge before
 * it reports the packages as unavailable. The project itself is already
 * usable at that point: the editor starts before the plugin appears.
 */
export const BRIDGE_WAIT_MS = 120_000;

/** How often a lost bridge is polled again. */
export const RECONNECT_MS = 2_000;

type EditorBridgeOptions = {
  /**
   * Builds the package file system for one editor instance. `currentEditor`
   * reads the live instance: the page restarts the engine, and writes must
   * reach the new one.
   */
  createFiles: (
    editor: GodotEditorInstance,
    currentEditor: () => GodotEditorInstance | null,
  ) => PackageFileSystem;
  /** The transport became usable and package state should be reloaded. */
  onConnected: () => void;
  /** A transport failure: the bridge is gone or silent. */
  onTransportError: (cause: unknown) => void;
  /** A connect failure, or `null` once the connection recovered. */
  onConnectError: (message: AppMessage | null) => void;
};

export type EditorBridgeTransport = {
  fsReady: boolean;
  filesRef: React.RefObject<PackageFileSystem | null>;
  engineRef: React.RefObject<GodotEditorInstance | null>;
  /**
   * Called once the editor reported ready. Waits for the editor plugin in the
   * background and must never delay the editor itself.
   */
  afterEditorStart: (editor: GodotEditorInstance) => void;
  /** Only transport failures drop readiness; the error is re-thrown. */
  guarded: <T>(action: () => Promise<T>) => Promise<T>;
  /** Reports a transport loss discovered outside `guarded`. */
  dropTransport: (cause: unknown) => void;
  /** Forgets the editor, the file system and any pending wait. */
  reset: () => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the transport to the Wired editor plugin: the editor instance, the
 * package file system created on top of it, the wait for a late bridge and the
 * reconnect loop after a transport loss.
 *
 * The hook is deliberately independent of the package panel state: it only
 * reports transport transitions, so the panel can keep its own reducer pure.
 */
export function useEditorBridge(
  options: EditorBridgeOptions,
): EditorBridgeTransport {
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  });

  const [fsReady, setFsReady] = React.useState(false);
  const filesRef = React.useRef<PackageFileSystem | null>(null);
  const engineRef = React.useRef<GodotEditorInstance | null>(null);
  const reconnectRef = React.useRef<number | null>(null);
  const bridgeWaitRef = React.useRef<AbortController | null>(null);
  const connectingRef = React.useRef(false);
  const mountedRef = React.useRef(false);

  /**
   * Drops the file system bound to the previous editor instance.
   *
   * The plugin answers by request id only, so a call left in flight when the
   * engine restarts would otherwise resolve into the replacement's file system.
   */
  const disposeFiles = React.useCallback((): void => {
    filesRef.current?.dispose();
    filesRef.current = null;
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      bridgeWaitRef.current?.abort();
      bridgeWaitRef.current = null;
      if (reconnectRef.current !== null) {
        window.clearInterval(reconnectRef.current);
        reconnectRef.current = null;
      }
      disposeFiles();
    };
  }, [disposeFiles]);

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

  const connectRef = React.useRef<() => Promise<boolean>>(async () => false);

  const startReconnectLoop = React.useCallback((): void => {
    // An action that rejects after unmount must not install an interval
    // nothing would ever clear.
    if (!mountedRef.current) return;
    if (reconnectRef.current !== null) return;
    reconnectRef.current = window.setInterval(() => {
      if (window.__wiredEditorBridge?.request) {
        void connectRef.current();
      }
    }, RECONNECT_MS);
  }, []);

  /**
   * Transport loss only: the plugin is gone or silent, so every package action
   * is refused until the bridge answers again. An operation the plugin rejected
   * is a normal per-action failure and never lands here.
   */
  const dropTransport = React.useCallback(
    (cause: unknown): void => {
      if (!mountedRef.current) return;
      disposeFiles();
      setFsReady(false);
      optionsRef.current.onTransportError(cause);
      startReconnectLoop();
    },
    [disposeFiles, startReconnectLoop],
  );

  /**
   * Connects the package file system to the plugin once it is reachable.
   * Idempotent: the first successful connection wins and the reconnect loop
   * stops. A registered bridge is probed with one real round-trip (`sync`)
   * before readiness is declared, so a silent plugin cannot re-enable the
   * panel. The editor is already usable at this point.
   */
  const connect = React.useCallback(async (): Promise<boolean> => {
    if (filesRef.current) {
      stopReconnectLoop();
      return true;
    }
    // The initial wait and the 2 s loop can race; probe only once.
    if (connectingRef.current) return false;
    const editor = engineRef.current;
    if (!editor || !window.__wiredEditorBridge?.request) return false;

    connectingRef.current = true;
    let files: PackageFileSystem;
    try {
      files = optionsRef.current.createFiles(editor, () => engineRef.current);
    } catch (cause) {
      // A package problem must not prevent the editor from opening.
      connectingRef.current = false;
      console.error(cause);
      optionsRef.current.onConnectError({
        key: "Errors.packagesUnavailable",
      });
      return false;
    }

    try {
      await files.sync();
    } catch (cause) {
      connectingRef.current = false;
      if (cause instanceof EditorBridgeError) {
        dropTransport(cause);
      } else {
        // Not a transport loss, so no readiness drop and no transport message,
        // but the initial path must not dead-end: the loop re-probes.
        console.error(cause);
        optionsRef.current.onConnectError({
          key: "Errors.packagesUnavailable",
        });
        startReconnectLoop();
      }
      return false;
    }

    connectingRef.current = false;
    if (!mountedRef.current) return false;
    filesRef.current = files;
    stopReconnectLoop();
    setFsReady(true);
    optionsRef.current.onConnectError(null);
    optionsRef.current.onConnected();
    return true;
  }, [dropTransport, startReconnectLoop, stopReconnectLoop]);

  React.useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const afterEditorStart = React.useCallback(
    (editor: GodotEditorInstance): void => {
      engineRef.current = editor;
      // Whatever the previous editor was still doing belongs to a file system
      // that no longer exists, so its pending calls are abandoned first.
      disposeFiles();
      // A previous wait belongs to the editor instance that was just replaced.
      bridgeWaitRef.current?.abort();
      const controller = new AbortController();
      bridgeWaitRef.current = controller;
      void (async () => {
        try {
          await waitForEditorBridge(BRIDGE_WAIT_MS, {
            signal: controller.signal,
          });
          if (!mountedRef.current) return;
          await connect();
        } catch (cause) {
          // An aborted wait means the panel is gone or was reset: it is not a
          // missing bridge and must not surface as an error.
          if (cause instanceof EditorBridgeWaitCancelledError) return;
          if (!mountedRef.current) return;
          optionsRef.current.onConnectError({
            key: "Errors.bridgeMissing",
          });
          startReconnectLoop();
        }
      })();
    },
    [connect, disposeFiles, startReconnectLoop],
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
          dropTransport(cause);
        }
        throw cause;
      }
    },
    [dropTransport],
  );

  const reset = React.useCallback((): void => {
    bridgeWaitRef.current?.abort();
    bridgeWaitRef.current = null;
    stopReconnectLoop();
    engineRef.current = null;
    disposeFiles();
    connectingRef.current = false;
    setFsReady(false);
  }, [disposeFiles, stopReconnectLoop]);

  return {
    fsReady,
    filesRef,
    engineRef,
    afterEditorStart,
    guarded,
    dropTransport,
    reset,
  };
}
