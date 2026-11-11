"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  bridgeEvents,
  type PackageProgressEvent,
} from "@/lib/editorBridgeEvents";

// A finished package is transient good news; a loading or failed one has to
// stay visible until the bridge reports something newer for the same package.
const COMPLETE_DURATION_MS = 5_000;
const STICKY_DURATION_MS = Number.POSITIVE_INFINITY;

/**
 * One Sonner toast per package. Reusing the id turns every update into a
 * replacement of that package's toast instead of a new stacked one.
 */
export function packageToastId(packageId: string): string {
  return `package-progress-${packageId}`;
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

type ProgressBarProps = {
  percent: number;
  status: PackageProgressEvent["status"];
  /** Already-localized accessible label, e.g. "Heroes: 42% applied". */
  label: string;
  /** Already-localized percent text, e.g. "42%". */
  percentText: string;
};

/**
 * The per-package bar rendered as a toast description. It is a pure component
 * on purpose: Sonner renders descriptions from its own tree, so nothing here
 * may depend on the context of the component that emitted the event.
 */
function PackageProgressBar({
  percent,
  status,
  label,
  percentText,
}: ProgressBarProps) {
  const value = clampPercent(percent);
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1.5 w-36 overflow-hidden rounded-full bg-foreground/15"
      >
        <div
          className={
            status === "error"
              ? "h-full rounded-full bg-destructive transition-[width] duration-300"
              : "h-full rounded-full bg-emerald-500 transition-[width] duration-300"
          }
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-xs tabular-nums opacity-70">{percentText}</span>
    </div>
  );
}

/**
 * Renders the package transfer progress the editor bridge reports while the
 * room runtime applies published revisions. Everything goes through Sonner's
 * global `<Toaster />`, so this component renders nothing of its own and never
 * covers the game frame with a layer of its own.
 */
export function GameProgressToast() {
  const t = useTranslations("Game");

  useEffect(() => {
    const bar = (
      name: string,
      percent: number,
      status: PackageProgressEvent["status"],
    ) => {
      const value = clampPercent(percent);
      return (
        <PackageProgressBar
          percent={value}
          status={status}
          label={t("packageProgressLabel", { name, percent: value })}
          percentText={t("packagePercent", { percent: value })}
        />
      );
    };

    // `emitPackageProgress` routes failures to `packageError`, so both channels
    // feed the same handler.
    const onProgress = (event: PackageProgressEvent) => {
      const id = packageToastId(event.packageId);

      if (event.status === "error") {
        toast.error(t("packageApplyFailed", { name: event.name }), {
          id,
          duration: STICKY_DURATION_MS,
          description: (
            <div className="space-y-2">
              <p className="text-destructive">
                {event.errorMessage ?? t("packagesFailed")}
              </p>
              {bar(event.name, event.percent, "error")}
            </div>
          ),
        });
        return;
      }

      if (event.status === "complete") {
        toast.success(t("packageApplied", { name: event.name }), {
          id,
          duration: COMPLETE_DURATION_MS,
          description: bar(event.name, 100, "complete"),
        });
        return;
      }

      toast.loading(t("packageApplying", { name: event.name }), {
        id,
        duration: STICKY_DURATION_MS,
        description: bar(event.name, event.percent, "loading"),
      });
    };

    bridgeEvents.on("packageProgress", onProgress);
    bridgeEvents.on("packageError", onProgress);
    return () => {
      bridgeEvents.off("packageProgress", onProgress);
      bridgeEvents.off("packageError", onProgress);
    };
  }, [t]);

  return null;
}

export default GameProgressToast;
