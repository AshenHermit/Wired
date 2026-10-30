"use client";

import { Button } from "@/components/ui/button";
import { Loader2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { PackageSyncController } from "./use-package-sync";

const CONFLICT_REASON: Record<string, string> = {
  modified: "изменён локально",
  deleted: "удалён локально",
  untracked: "нет в опубликованной ревизии",
};

const PHASE_LABEL: Record<PackageSyncController["phase"], string> = {
  idle: "Ожидание редактора",
  syncing: "Синхронизация…",
  ready: "Актуально",
  conflict: "Конфликт",
  error: "Ошибка",
};

/**
 * Compact status panel for published room packages. It only reports and asks
 * what to do on a conflict; it never replaces local files silently.
 */
export function PackageSyncStatus({
  sync,
}: {
  sync: PackageSyncController;
}) {
  if (sync.phase === "idle") return null;

  const busy = sync.phase === "syncing";

  return (
    <div className="absolute bottom-4 left-4 z-20 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-white/15 bg-slate-950/90 p-3 text-xs text-white shadow-xl backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold">
          <span>Пакеты комнаты</span>
          <span
            className={
              sync.phase === "conflict" || sync.phase === "error"
                ? "text-amber-300"
                : "text-white/60"
            }
          >
            {PHASE_LABEL[sync.phase]}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-white/80 hover:text-white"
          disabled={busy || !sync.fsReady}
          onClick={() => void sync.syncNow()}
          title="Проверить опубликованные ревизии"
        >
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
        </Button>
      </div>

      {sync.entries.length > 0 && (
        <ul className="mt-2 space-y-1">
          {sync.entries.map((entry) => (
            <li key={entry.packageId} className="text-white/70">
              <span className="text-white/90">{entry.name}</span>{" "}
              <span className="text-white/50">ревизия {entry.revision}</span>
              <div className="text-white/60">{entry.message}</div>
            </li>
          ))}
        </ul>
      )}

      {sync.conflicts.map((conflict) => (
        <div
          key={conflict.packageId}
          className="mt-2 rounded-md border border-amber-400/30 bg-amber-400/10 p-2"
        >
          <div className="flex items-center gap-1.5 font-medium text-amber-200">
            <TriangleAlertIcon className="size-3.5" />
            {conflict.name}: локальные правки не перезаписаны
          </div>
          <ul className="mt-1 space-y-0.5 text-white/70">
            {conflict.conflicts.slice(0, 5).map((file) => (
              <li key={file.filepath} className="truncate">
                <span className="font-mono text-white/90">
                  {file.filepath}
                </span>{" "}
                — {CONFLICT_REASON[file.reason] ?? file.reason}
              </li>
            ))}
            {conflict.conflicts.length > 5 && (
              <li>и ещё {conflict.conflicts.length - 5}…</li>
            )}
          </ul>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 px-2"
              onClick={() =>
                void sync.resolveConflict(conflict.packageId, "keep-local")
              }
            >
              Оставить локальные
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-7 px-2"
              onClick={() =>
                void sync.resolveConflict(
                  conflict.packageId,
                  "replace-published",
                )
              }
            >
              Заменить опубликованными
            </Button>
          </div>
        </div>
      ))}

      {sync.error && sync.phase === "error" && (
        <div className="mt-2 text-amber-200">{sync.error}</div>
      )}
    </div>
  );
}
