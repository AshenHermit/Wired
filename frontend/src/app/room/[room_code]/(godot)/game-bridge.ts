/**
 * Typed contract for the same-origin postMessage bridge between the Wired app
 * and the exported Godot build (`_wired/web/shell.html`).
 *
 * The game ticket travels only inside `wired:configure`, after the iframe
 * reports `wired:game-ready`. It must never be put in a URL or a log.
 */

/**
 * Payload of `wired:configure`.
 *
 * `shell.html`'s `acceptConfig` copies these fields one by one into the engine
 * config instead of forwarding the object, so a new field is invisible to
 * GDScript until it is added there as well.
 */
export type GameConfigurePayload = {
  endpoint: string;
  ticket: string;
  room: number;
  /**
   * Absolute same-origin API root (`<origin>/api`). The exported Web build is
   * served from the frontend origin, so `HTTPRequest` must not resolve package
   * URLs relatively: the host tells the engine where `/api` lives.
   */
  apiBase: string;
};

export type GameStatusStage =
  | "booted"
  | "waiting"
  | "connecting"
  | "authenticated"
  | "ready"
  | "connection_failed"
  | "disconnected"
  | "error";

const STATUS_STAGES: readonly GameStatusStage[] = [
  "booted",
  "waiting",
  "connecting",
  "authenticated",
  "ready",
  "connection_failed",
  "disconnected",
  "error",
];

export type GameToHostMessage =
  | { source: "wired-game"; type: "wired:game-booted"; payload: Record<string, never> }
  | { source: "wired-game"; type: "wired:game-ready"; payload: Record<string, never> }
  | {
      source: "wired-game";
      type: "wired:game-configured";
      payload: { room: number };
    }
  | {
      source: "wired-game";
      type: "wired:game-status";
      payload: { stage: GameStatusStage; detail?: string };
    }
  | {
      source: "wired-game";
      type: "wired:game-error";
      payload: { message: string };
    }
  | {
      source: "wired-game";
      type: "wired:game-event";
      payload: { event: unknown };
    };

export type HostToGameMessage =
  | {
      source: "wired-host";
      type: "wired:configure";
      payload: GameConfigurePayload;
    }
  | { source: "wired-host"; type: "wired:ping"; payload: Record<string, never> };

const GAME_SOURCE = "wired-game";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/**
 * Validates the shape of every message the host dereferences. The bridge is
 * same-origin, but it is still untrusted input: a malformed payload must be
 * ignored instead of throwing inside the message listener.
 */
export function isGameMessage(data: unknown): data is GameToHostMessage {
  if (!isRecord(data) || data.source !== GAME_SOURCE) {
    return false;
  }
  if (typeof data.type !== "string" || !isRecord(data.payload)) {
    return false;
  }
  const payload = data.payload;
  switch (data.type) {
    case "wired:game-booted":
    case "wired:game-ready":
      return true;
    case "wired:game-configured":
      return typeof payload.room === "number";
    case "wired:game-status":
      return (
        typeof payload.stage === "string" &&
        STATUS_STAGES.includes(payload.stage as GameStatusStage) &&
        (payload.detail === undefined || typeof payload.detail === "string")
      );
    case "wired:game-error":
      return typeof payload.message === "string";
    case "wired:game-event":
      return "event" in payload;
    default:
      return false;
  }
}

export function postToGame(iframe: HTMLIFrameElement, message: HostToGameMessage) {
  iframe.contentWindow?.postMessage(message, window.location.origin);
}

export function postGameConfigure(
  iframe: HTMLIFrameElement,
  payload: GameConfigurePayload,
) {
  postToGame(iframe, {
    source: "wired-host",
    type: "wired:configure",
    payload,
  });
}

export function postGamePing(iframe: HTMLIFrameElement) {
  postToGame(iframe, {
    source: "wired-host",
    type: "wired:ping",
    payload: {},
  });
}
