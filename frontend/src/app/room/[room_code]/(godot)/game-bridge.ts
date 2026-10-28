/**
 * Typed contract for the same-origin postMessage bridge between the Wired app
 * and the exported Godot build (`_wired/web/shell.html`).
 *
 * The game ticket travels only inside `wired:configure`, after the iframe
 * reports `wired:game-ready`. It must never be put in a URL or a log.
 */
export type GameConfigurePayload = {
  endpoint: string;
  ticket: string;
  room: number;
};

export type GameStatusStage =
  | "waiting"
  | "connecting"
  | "authenticated"
  | "ready"
  | "connection_failed"
  | "disconnected"
  | "error";

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
      payload: { stage: GameStatusStage; detail: string };
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

export function isGameMessage(data: unknown): data is GameToHostMessage {
  if (!data || typeof data !== "object") {
    return false;
  }
  const candidate = data as { source?: unknown; type?: unknown };
  return (
    candidate.source === GAME_SOURCE &&
    typeof candidate.type === "string" &&
    candidate.type.startsWith("wired:")
  );
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
