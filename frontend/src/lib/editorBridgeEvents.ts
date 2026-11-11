/**
 * The editor bridge's event channel.
 *
 * Package revisions are written by the bridge into the running editor, which
 * has no way to render anything itself, while the Game tab must not import
 * editor-only code to learn about them. This module is the single, cheap
 * channel between the two: it carries plain data only, so subscribing costs the
 * consumer nothing but the event payload.
 *
 * The payload mirrors the server's `PackageProgressPayload` minus the raw byte
 * counts, which the UI cannot use directly: `percent` is derived from them
 * here.
 */
import type { PackageProgressPayload } from "@wired-io/shared";
import mitt, { type Emitter } from "mitt";

export type PackageProgressEvent = Omit<
  PackageProgressPayload,
  "loadedBytes" | "totalBytes"
> & {
  /** Whole percent of the package written so far, `0`-`100`. */
  percent: number;
};

export type EditorBridgeEvents = {
  packageProgress: PackageProgressEvent;
  packageError: PackageProgressEvent;
};

export type EditorBridgeEmitter = Emitter<EditorBridgeEvents>;

/** The one emitter every producer and consumer of bridge events shares. */
export const bridgeEvents: EditorBridgeEmitter = mitt<EditorBridgeEvents>();

/**
 * Derives a whole percent from byte counts. An unknown total (`0`) reports
 * `0`, and a loaded count above the total is capped at `100`, so a progress bar
 * never receives a nonsensical value.
 */
export function packagePercent(
  loadedBytes: number,
  totalBytes: number,
): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  if (!Number.isFinite(loadedBytes) || loadedBytes <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, Math.round((loadedBytes / totalBytes) * 100)),
  );
}

/**
 * Forwards one package progress event. Failures go to `packageError` and
 * everything else to `packageProgress`, so a listener that only renders errors
 * never has to filter the stream.
 */
export function emitPackageProgress(event: PackageProgressEvent): void {
  bridgeEvents.emit(
    event.status === "error" ? "packageError" : "packageProgress",
    event,
  );
}

export default bridgeEvents;
