"use client";

import * as React from "react";
import { getRoomPackages } from "@/api/services/godot-game";
import type { GodotEditorInstance } from "./GodotEditorInstance";
import {
  createPackageFileSystem,
  type PackageFileSystem,
} from "./godot-packages-fs";
import {
  reconcilePackageRevision,
  type PackageBaseline,
  type PackageConflict,
} from "./package-sync";

/** How often the editor checks for a newer published revision. */
const POLL_MS = 10_000;
const BASELINE_PREFIX = "wired:package-baseline";

export type PackageSyncPhase = "idle" | "syncing" | "ready" | "conflict" | "error";

export type PackageEntryState =
  | "applied"
  | "up-to-date"
  | "conflict"
  | "error";

export type PackageSyncEntry = {
  packageId: number;
  name: string;
  revision: number;
  state: PackageEntryState;
  message: string;
};

export type PackageConflictPrompt = {
  packageId: number;
  name: string;
  revision: number;
  conflicts: PackageConflict[];
};

export type PackageSyncSnapshot = {
  phase: PackageSyncPhase;
  entries: PackageSyncEntry[];
  conflicts: PackageConflictPrompt[];
  error: string | null;
};

export type PackageSyncController = PackageSyncSnapshot & {
  fsReady: boolean;
  /** Runs before the editor starts, so imported resources see packages first. */
  beforeEditorStart: (editor: GodotEditorInstance) => Promise<void>;
  syncNow: () => Promise<void>;
  resolveConflict: (
    packageId: number,
    action: "keep-local" | "replace-published",
  ) => Promise<void>;
};

const initialState: PackageSyncSnapshot = {
  phase: "idle",
  entries: [],
  conflicts: [],
  error: null,
};

function baselineKey(roomId: number, packageId: number): string {
  return `${BASELINE_PREFIX}:${roomId}:${packageId}`;
}

export function loadPackageBaseline(
  roomId: number,
  packageId: number,
): PackageBaseline | null {
  try {
    const raw = window.localStorage.getItem(baselineKey(roomId, packageId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PackageBaseline;
    if (
      !parsed ||
      !Number.isInteger(parsed.revision) ||
      typeof parsed.files !== "object" ||
      parsed.files === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function savePackageBaseline(
  roomId: number,
  packageId: number,
  baseline: PackageBaseline,
): void {
  try {
    window.localStorage.setItem(
      baselineKey(roomId, packageId),
      JSON.stringify(baseline),
    );
  } catch {
    // Storage may be unavailable; the next sync then reports a conflict
    // instead of silently replacing local files.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the editor package directories in sync with the published revisions of
 * the room.
 *
 * The backend status is only a hint that a revision exists; files are always
 * downloaded over HTTP and verified against the manifest. Local edits that
 * would be overwritten or deleted are surfaced as a conflict and stay on disk
 * until the user chooses to replace them.
 */
export function usePackageSync(roomId: number): PackageSyncController {
  const [snapshot, setSnapshot] = React.useState<PackageSyncSnapshot>(initialState);
  const [fsReady, setFsReady] = React.useState(false);
  const filesRef = React.useRef<PackageFileSystem | null>(null);
  const syncingRef = React.useRef(false);
  const skippedRef = React.useRef<Set<number>>(new Set());
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    filesRef.current = null;
    skippedRef.current = new Set();
    setFsReady(false);
    setSnapshot(initialState);
  }, [roomId]);

  const syncAll = React.useCallback(async (): Promise<void> => {
    const files = filesRef.current;
    if (!files || syncingRef.current) return;
    syncingRef.current = true;
    setSnapshot((previous) => ({
      ...previous,
      phase: "syncing",
      error: null,
    }));

    try {
      const status = await getRoomPackages(roomId);
      const entries: PackageSyncEntry[] = [];
      const conflicts: PackageConflictPrompt[] = [];
      const errors: string[] = [];

      for (const pkg of status.packages) {
        if (skippedRef.current.has(pkg.packageId)) {
          entries.push({
            packageId: pkg.packageId,
            name: pkg.name,
            revision: pkg.revision,
            state: "conflict",
            message:
              "Оставлены локальные файлы; синхронизация приостановлена до перезагрузки страницы.",
          });
          continue;
        }

        try {
          const result = await reconcilePackageRevision(
            pkg.packageId,
            files,
            loadPackageBaseline(roomId, pkg.packageId),
          );

          if (result.status === "conflict") {
            conflicts.push({
              packageId: pkg.packageId,
              name: pkg.name,
              revision: result.revision,
              conflicts: result.conflicts,
            });
            entries.push({
              packageId: pkg.packageId,
              name: pkg.name,
              revision: result.revision,
              state: "conflict",
              message: `Локальные изменения в ${result.conflicts.length} файл(ах)`,
            });
            continue;
          }

          savePackageBaseline(roomId, pkg.packageId, {
            revision: result.revision,
            files: result.files,
          });
          entries.push({
            packageId: pkg.packageId,
            name: pkg.name,
            revision: result.revision,
            state: result.status,
            message:
              result.status === "applied"
                ? `Применено файлов: ${result.written.length}, удалено: ${result.deleted.length}. Импорт обновится после перезапуска редактора.`
                : "Актуальная ревизия",
          });
        } catch (error) {
          const message = errorMessage(error);
          errors.push(`Пакет ${pkg.name}: ${message}`);
          entries.push({
            packageId: pkg.packageId,
            name: pkg.name,
            revision: pkg.revision,
            state: "error",
            message,
          });
        }
      }

      if (!mountedRef.current) return;
      setSnapshot({
        phase:
          conflicts.length > 0
            ? "conflict"
            : errors.length > 0
              ? "error"
              : "ready",
        entries,
        conflicts,
        error: errors[0] ?? null,
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setSnapshot((previous) => ({
        ...previous,
        phase: "error",
        error: `Не удалось получить пакеты комнаты: ${errorMessage(error)}`,
      }));
    } finally {
      syncingRef.current = false;
    }
  }, [roomId]);

  const beforeEditorStart = React.useCallback(
    async (editor: GodotEditorInstance): Promise<void> => {
      try {
        filesRef.current = createPackageFileSystem(editor);
        setFsReady(true);
        await syncAll();
      } catch (error) {
        // The editor must still start: a package problem is reported in the
        // panel, not as a fatal editor error.
        if (!mountedRef.current) return;
        setSnapshot((previous) => ({
          ...previous,
          phase: "error",
          error: `Пакеты недоступны: ${errorMessage(error)}`,
        }));
      }
    },
    [syncAll],
  );

  React.useEffect(() => {
    if (!fsReady) return;
    const tick = () => {
      if (document.visibilityState === "visible") {
        void syncAll();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fsReady, syncAll]);

  const resolveConflict = React.useCallback(
    async (
      packageId: number,
      action: "keep-local" | "replace-published",
    ): Promise<void> => {
      if (action === "keep-local") {
        skippedRef.current.add(packageId);
        setSnapshot((previous) => {
          const conflicts = previous.conflicts.filter(
            (conflict) => conflict.packageId !== packageId,
          );
          return {
            ...previous,
            conflicts,
            phase: conflicts.length > 0 ? "conflict" : "ready",
            entries: previous.entries.map((entry) =>
              entry.packageId === packageId
                ? {
                    ...entry,
                    message:
                      "Оставлены локальные файлы; синхронизация приостановлена до перезагрузки страницы.",
                  }
                : entry,
            ),
          };
        });
        return;
      }

      const files = filesRef.current;
      if (!files) return;
      try {
        const result = await reconcilePackageRevision(
          packageId,
          files,
          loadPackageBaseline(roomId, packageId),
          { force: true },
        );
        if (result.status === "applied" || result.status === "up-to-date") {
          savePackageBaseline(roomId, packageId, {
            revision: result.revision,
            files: result.files,
          });
        }
        await syncAll();
      } catch (error) {
        if (!mountedRef.current) return;
        setSnapshot((previous) => ({
          ...previous,
          phase: "error",
          error: `Не удалось применить пакет: ${errorMessage(error)}`,
        }));
      }
    },
    [roomId, syncAll],
  );

  return {
    ...snapshot,
    fsReady,
    beforeEditorStart,
    syncNow: syncAll,
    resolveConflict,
  };
}
