"use client";

import {
  Room,
  activePackages,
  isGameConnectionErrorCode,
  packagesApplied,
  type GameConnectionErrorCode,
  type GameRoomRuntimeStatus,
  type RoomPackagesStatus,
} from "@wired-io/shared";
import React from "react";
import { useTranslations } from "next-intl";
import {
  createGameConnection,
  getGameRoomStatus,
  getRoomPackages,
} from "@/api/services/godot-game";
import { Spinner } from "@/components/ui/spinner";
import { apiErrorBody, apiErrorResponse } from "@/i18n/api-error";
import { useAppMessage, type AppMessage } from "@/i18n/message";
import { API_PREFIX } from "@/utils/variables";
import { readAccessToken } from "@/utils/auth-cookie";
import {
  type GameStatusStage,
  isGameMessage,
  postGameConfigure,
  postGamePing,
} from "@/godot/bridge/game-bridge";

type GamePhase =
  | "checking"
  | "loading"
  | "requesting"
  | "handshake"
  | "ready"
  | "reconnecting"
  | "error";

// The backend is proxied under a single prefix on the frontend origin: the
// export is fetched from it and the Web build asks for package files below it.
const EXPORT_URL = `${API_PREFIX}/game-export/index.html`;
const MAX_AUTO_RETRIES = 3;
// The engine bundle is ~36 MB, so a cold load on a slow link can take far
// longer than 30 seconds. Export assets are revalidated with ETags, so this
// only affects the first load of a build, not reconnects.
const LOAD_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const STATUS_POLL_MS = 5_000;
// A cold runtime start has to launch Godot and apply every package revision
// before the backend can mint a usable ticket. The connection flow waits for
// that instead of turning a normal startup into "РРіСЂР° РЅРµРґРѕСЃС‚СѓРїРЅР°".
const CONNECTION_WAIT_MS = 90_000;
const RUNTIME_POLL_MS = 1_000;
const CONNECTION_RETRY_MS = 2_000;
// A ready frame that stops answering for this long is treated as a crashed
// WASM engine. The backend status poll can stay healthy while the engine is
// dead, so liveness has to be observed on the frame itself.
const HEARTBEAT_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * The whole Game tab state machine. `attempt` is the iframe generation: a
 * reconnect bumps it to replace the frame. `ticketRequest` is the one piece of
 * intent the asynchronous ticket effect needs: it is the attempt that asked
 * for a ticket, and setting it to `null` cancels an in-flight request.
 */
type GameState = {
  attempt: number;
  exportReady: boolean;
  phase: GamePhase;
  message: GameMessage;
  players: number;
  events: string[];
  autoRetries: number;
  /** Attempt whose ticket was already requested from the backend. */
  sentAttempt: number | null;
  /** Attempt awaiting a ticket; `null` cancels an in-flight request. */
  ticketRequest: number | null;
  /** The frame acknowledged the configured ticket. */
  acknowledged: boolean;
};

export type GameMessage = AppMessage | { raw: string };

const INITIAL_STATE: GameState = {
  attempt: 0,
  exportReady: false,
  phase: "checking",
  message: { key: "Game.checkingExport" },
  players: 0,
  events: [],
  autoRetries: 0,
  sentAttempt: null,
  ticketRequest: null,
  acknowledged: false,
};

type GameAction =
  | { type: "export-ready" }
  | { type: "export-failed"; message: AppMessage }
  | { type: "booted" }
  | { type: "frame-ready" }
  | { type: "configured-sent"; attempt: number }
  | { type: "configured" }
  | { type: "connection-wait"; attempt: number; message: AppMessage }
  | { type: "status"; stage: GameStatusStage; detail?: string }
  | { type: "game-error"; message: GameMessage }
  | { type: "event"; name: string; players?: number }
  | { type: "players"; count: number }
  | { type: "ticket-failed"; message: GameMessage }
  | { type: "handshake-timeout"; attempt: number }
  | { type: "load-timeout"; attempt: number }
  | { type: "transport-lost" }
  | { type: "auto-retry" }
  | { type: "retry" };

/** Stops the tab on a message and invalidates any in-flight ticket. */
function fail(state: GameState, message: GameMessage): GameState {
  return {
    ...state,
    phase: "error",
    message,
    // A frame that already failed must not be resurrected by a late connection
    // response: the effect that owns the request is cancelled by this change.
    ticketRequest: null,
    acknowledged: false,
  };
}

/**
 * Schedules the next reconnect, or gives up after `MAX_AUTO_RETRIES`. The
 * backoff timer lives in an effect that watches `phase`/`autoRetries`; the
 * reducer only records how many attempts were used.
 */
function startReconnect(state: GameState): GameState {
  if (state.phase === "error" || state.phase === "reconnecting") {
    return state;
  }
  if (state.autoRetries >= MAX_AUTO_RETRIES) {
    return fail(state, { key: "Game.connectionLost" });
  }
  const delay = Math.min(1_000 * 2 ** state.autoRetries, 8_000);
  return {
    ...state,
    phase: "reconnecting",
    message: {
      key: "Game.reconnecting",
      values: { seconds: Math.round(delay / 1_000) },
    },
    autoRetries: state.autoRetries + 1,
    ticketRequest: null,
    sentAttempt: null,
    acknowledged: false,
  };
}

function replaceFrame(state: GameState, attempt: number): GameState {
  return {
    ...state,
    attempt,
    exportReady: false,
    phase: "checking",
    message: { key: "Game.checkingExport" },
    sentAttempt: null,
    ticketRequest: null,
    acknowledged: false,
  };
}

function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "export-ready":
      return {
        ...state,
        exportReady: true,
        phase: "loading",
        message: { key: "Game.loadingEngine" },
      };
    case "export-failed":
      return { ...fail(state, action.message), exportReady: false };
    case "booted":
      return state.phase === "error"
        ? state
        : {
            ...state,
            phase: "loading",
            message: { key: "Game.engineLoading" },
          };
    case "frame-ready":
      // A frame that already errored (for example, its config wait elapsed)
      // must not mint another ticket during a retry: only the retry button or
      // a reloaded frame may ask again.
      if (state.phase === "error" || state.sentAttempt === state.attempt) {
        return state;
      }
      return {
        ...state,
        sentAttempt: state.attempt,
        ticketRequest: state.attempt,
        phase: "requesting",
        message: { key: "Game.requestingConnection" },
      };
    case "configured-sent":
      if (state.ticketRequest !== action.attempt || state.phase === "error") {
        return state;
      }
      return {
        ...state,
        phase: "handshake",
        message: { key: "Game.sendingTicket" },
        acknowledged: false,
      };
    case "configured":
      if (state.sentAttempt !== state.attempt || state.phase === "error") {
        return state;
      }
      return {
        ...state,
        phase: "handshake",
        message: { key: "Game.ticketAccepted" },
        acknowledged: true,
      };
    case "connection-wait":
      // The ticket has not been handed to the frame yet, so this only updates
      // progress. Once `configured-sent` moved the phase to the handshake, the
      // connection is owned by the frame and a late status poll must not move
      // it backwards.
      if (
        state.attempt !== action.attempt ||
        state.phase === "error" ||
        state.phase === "handshake"
      ) {
        return state;
      }
      if (state.message === action.message) return state;
      return { ...state, message: action.message };
    case "status": {
      if (state.phase === "error") return state;
      const sent = state.sentAttempt === state.attempt;
      switch (action.stage) {
        case "booted":
          // The engine script is loaded, but the game is not joined yet.
          return state;
        case "waiting":
        case "connecting":
          return {
            ...state,
            phase: "handshake",
            message: { key: "Game.connectingServer" },
          };
        case "authenticated":
          return {
            ...state,
            phase: "handshake",
            message: { key: "Game.authenticating" },
            acknowledged: true,
          };
        case "ready":
          // "ready" means an authenticated, configured peer, never just a
          // booted engine. Ignore it before the ticket was sent.
          if (!sent) return state;
          return {
            ...state,
            phase: "ready",
            message: { key: "Game.ready" },
            autoRetries: 0,
          };
        case "connection_failed":
        case "disconnected":
          return startReconnect(state);
        case "error":
          return fail(
            state,
            action.detail ? { raw: action.detail } : { key: "Game.error" },
          );
        default:
          return state;
      }
    }
    case "game-error":
      // Keep the first, actionable error: a frame that times out waiting for a
      // ticket must not overwrite the host's own startup error a minute later.
      if (state.phase === "error") return state;
      return fail(state, action.message);
    case "event":
      return {
        ...state,
        events: [...state.events.slice(-3), action.name],
        players: action.players ?? state.players,
      };
    case "players":
      return { ...state, players: action.count };
    case "ticket-failed":
      return fail(state, action.message);
    case "handshake-timeout":
      if (
        state.phase !== "handshake" ||
        state.acknowledged ||
        state.attempt !== action.attempt
      ) {
        return state;
      }
      return fail(state, { key: "Game.handshakeTimeout" });
    case "load-timeout":
      if (state.phase === "error" || state.sentAttempt === state.attempt) {
        return state;
      }
      return fail(state, { key: "Game.loadTimeout" });
    case "transport-lost":
      return startReconnect(state);
    case "auto-retry":
      if (state.phase !== "reconnecting") return state;
      return replaceFrame(state, state.attempt + 1);
    case "retry":
      return {
        ...replaceFrame(state, state.attempt + 1),
        players: 0,
        events: [],
        autoRetries: 0,
      };
    default:
      return state;
  }
}

/**
 * Errors that mean "the runtime is still coming up": the next tick must poll
 * its state and retry instead of failing the whole Game tab.
 */
const RETRYABLE_CONNECTION_CODES = new Set<GameConnectionErrorCode>([
  "packages_pending",
  "room_stopping",
  "room_not_running",
  "handshake_window_expired",
]);

const CONNECTION_MESSAGE_BY_CODE: Partial<
  Record<GameConnectionErrorCode, AppMessage>
> = {
  packages_pending: { key: "Game.applyingPackages" },
  room_stopping: { key: "Game.serverRestarting" },
  room_not_running: { key: "Game.serverStarting" },
  handshake_window_expired: { key: "Game.serverRestarting" },
};

const FATAL_CONNECTION_MESSAGE_BY_CODE: Partial<
  Record<GameConnectionErrorCode, AppMessage>
> = {
  packages_failed: { key: "Game.packagesFailed" },
  start_failed: { key: "Game.startFailed" },
  config: { key: "Game.notConfigured" },
  ticket_secret_missing: { key: "Game.notConfigured" },
};

type ConnectionFailure = {
  retryable: boolean;
  message: AppMessage;
  retryAfterMs: number;
};

/** Keeps the structured backend `code` available to the retry loop. */
function describeConnectionFailure(error: unknown): ConnectionFailure {
  const status = apiErrorResponse(error)?.status;
  const data = apiErrorBody<{ code?: unknown; retryAfterSeconds?: unknown }>(
    error,
  );
  const code = isGameConnectionErrorCode(data?.code) ? data.code : null;

  if (status === 429) {
    const retryAfterSeconds = Number(data?.retryAfterSeconds);
    const seconds =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds
        : 5;
    return {
      retryable: true,
      message: { key: "Game.rateLimited", values: { seconds } },
      retryAfterMs: seconds * 1_000,
    };
  }
  if (code !== null && RETRYABLE_CONNECTION_CODES.has(code)) {
    return {
      retryable: true,
      message: CONNECTION_MESSAGE_BY_CODE[code] ?? {
        key: "Game.serverStillStarting",
      },
      retryAfterMs: CONNECTION_RETRY_MS,
    };
  }
  console.error(error);
  return {
    retryable: false,
    message: (code !== null && FATAL_CONNECTION_MESSAGE_BY_CODE[code]) || {
      key: "Game.connectFailed",
    },
    retryAfterMs: 0,
  };
}

/** Human-readable runtime stage shown while the ticket is being obtained. */
function runtimeMessage(
  status: GameRoomRuntimeStatus,
  packagesApplied: boolean,
  appliedPackages: number,
  totalPackages: number,
): AppMessage {
  switch (status.state) {
    case "starting":
      return { key: "Game.runtimeStarting" };
    case "stopping":
      return { key: "Game.runtimeRestarting" };
    case "running":
      if (packagesApplied) return { key: "Game.runtimeReady" };
      return totalPackages > 0
        ? {
            key: "Game.runtimeApplying",
            values: { applied: appliedPackages, total: totalPackages },
          }
        : { key: "Game.runtimePreparing" };
    case "failed":
      return { key: "Game.runtimeRestarting" };
    default:
      return { key: "Game.runtimeDefault" };
  }
}

class GameTabError extends Error {
  constructor(readonly appMessage: AppMessage) {
    super(appMessage.key);
  }
}

/**
 * Whether any active package has failed to apply. Shares `activePackages` with
 * the readiness gate so a package cannot count as applied here and failed there.
 */
export function packagesFailed(packages: RoomPackagesStatus): boolean {
  const active = new Set(
    activePackages(packages).map(({ packageId }) => packageId),
  );
  return packages.packages.some(
    (entry) => active.has(entry.packageId) && entry.runtime.state === "failed",
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Reads the runtime state and the packages the room expects to see applied. */
async function readRuntimeState(roomId: number) {
  const [status, packages] = await Promise.all([
    getGameRoomStatus(roomId),
    getRoomPackages(roomId),
  ]);
  return { status, packages };
}

/** Reports how far the runtime is from applying the room's active packages. */
function reportRuntimeProgress(
  status: GameRoomRuntimeStatus,
  packages: RoomPackagesStatus,
  onProgress: (message: AppMessage) => void,
): void {
  const active = activePackages(packages);
  const applied = active.filter(({ packageId, revision }) => {
    const entry = packages.packages.find((pkg) => pkg.packageId === packageId);
    return (
      entry?.runtime.state === "applied" && entry.runtime.revision >= revision
    );
  }).length;
  onProgress(
    runtimeMessage(status, packagesApplied(packages), applied, active.length),
  );
}

interface RuntimeWaitOptions {
  /** Set when the effect that started the wait was torn down. */
  signal: AbortSignal;
  onProgress: (message: AppMessage) => void;
}

/**
 * Waits until the runtime runs the room's active packages.
 *
 * Returns as soon as the runtime is either ready or in a state the connection
 * POST has to restart (idle, stopped, crashed). `starting` and `stopping` are
 * the only states worth waiting out, because the POST is what starts a stopped
 * runtime.
 */
async function waitForRuntimeUntil(
  roomId: number,
  deadline: number,
  { signal, onProgress }: RuntimeWaitOptions,
): Promise<void> {
  for (;;) {
    const { status, packages } = await readRuntimeState(roomId);
    reportRuntimeProgress(status, packages, onProgress);
    if (signal.aborted) {
      return;
    }
    if (packagesFailed(packages)) {
      throw new GameTabError({ key: "Game.packagesFailed" });
    }
    if (status.state === "running" && packagesApplied(packages)) {
      return;
    }
    if (
      status.state === "idle" ||
      status.state === "stopped" ||
      status.state === "failed"
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new GameTabError({ key: "Game.waitTimeout" });
    }
    await sleep(RUNTIME_POLL_MS);
    if (signal.aborted) {
      return;
    }
  }
}

/**
 * The Godot Web build runs in a same-origin iframe. The host waits for the
 * engine to boot, requests a fresh single-use ticket, and hands it over with
 * postMessage. A reconnect reloads the iframe, which is the only way to get a
 * clean engine instance and a new handshake on this protocol version.
 */
export function GameTab({ room }: { room: Room }) {
  const [state, dispatch] = React.useReducer(gameReducer, INITIAL_STATE);
  const { attempt, exportReady, phase, message, players, events, autoRetries } =
    state;
  const format = useAppMessage();
  const t = useTranslations("Game");
  const common = useTranslations("Common");
  const messageText = "raw" in message ? message.raw : format(message);

  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const lastFrameMessageAtRef = React.useRef(0);

  // The game canvas only receives keyboard input while it (or its iframe) holds
  // focus. Emit/package actions and tab switches move focus to buttons or the
  // document, so re-focus the frame whenever the game becomes ready and on
  // click, otherwise WASD/Space stop working while the mouse still does.
  React.useEffect(() => {
    if (phase !== "ready") return;
    const frame = iframeRef.current;
    if (frame) {
      window.requestAnimationFrame(() => frame.focus());
    }
  }, [phase, attempt]);

  const focusFrame = React.useCallback(() => {
    iframeRef.current?.focus();
  }, []);

  // Verify the export exists before mounting the frame, so an unbuilt export
  // produces an actionable message instead of a silent blank iframe.
  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(EXPORT_URL, { cache: "no-store" });
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          dispatch({
            type: "export-failed",
            message:
              response.status === 404
                ? { key: "Game.buildMissing" }
                : {
                    key: "Game.loadFailed",
                    values: { status: response.status },
                  },
          });
          return;
        }
        dispatch({ type: "export-ready" });
      } catch (error) {
        if (!cancelled) {
          console.error(error);
          dispatch({
            type: "export-failed",
            message: { key: "Game.backendUnreachable" },
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // One ticket per ready frame. `ticketRequest` is cleared by every action that
  // invalidates the pending request, which cancels this effect. A cold runtime
  // start is not an error: poll its state and retry until it is ready, then
  // hand the fresh ticket to the frame.
  React.useEffect(() => {
    const request = state.ticketRequest;
    if (request === null) {
      return;
    }
    let cancelled = false;
    const abort = new AbortController();

    const waitMessage = (message: AppMessage) => {
      if (!cancelled) {
        dispatch({ type: "connection-wait", attempt: request, message });
      }
    };

    const describeRuntime = (
      status: GameRoomRuntimeStatus,
      packages: RoomPackagesStatus,
    ) => reportRuntimeProgress(status, packages, waitMessage);

    const waitForRuntime = (deadline: number) =>
      waitForRuntimeUntil(room.id, deadline, {
        signal: abort.signal,
        onProgress: waitMessage,
      });

    void (async () => {
      const deadline = Date.now() + CONNECTION_WAIT_MS;
      try {
        for (;;) {
          await waitForRuntime(deadline);
          if (cancelled) return;

          // The POST is what starts a stopped runtime and waits for its first
          // package pass. Keep the overlay informative while it is in flight.
          const poller = window.setInterval(() => {
            void readRuntimeState(room.id)
              .then(({ status, packages }) => describeRuntime(status, packages))
              .catch(() => {
                // The request itself owns the real error.
              });
          }, RUNTIME_POLL_MS);

          try {
            const packageStatus = await getRoomPackages(room.id);
            const packages = activePackages(packageStatus);
            const connection = await createGameConnection(room.id);
            if (cancelled) {
              return;
            }
            const frame = iframeRef.current;
            if (!frame?.contentWindow) {
              dispatch({
                type: "ticket-failed",
                message: { key: "Game.frameMissing" },
              });
              return;
            }
            dispatch({ type: "configured-sent", attempt: request });
            postGameConfigure(frame, {
              endpoint: connection.endpoint,
              ticket: connection.ticket,
              room: connection.roomId,
              // The Web build cannot guess the backend: it is proxied under the
              // same prefix that serves the Game tab.
              apiBase: `${window.location.origin}${API_PREFIX}`,
              apiToken: readAccessToken() ?? "",
              packages,
            });
            return;
          } catch (error) {
            if (cancelled) {
              return;
            }
            const failure = describeConnectionFailure(error);
            if (!failure.retryable || Date.now() >= deadline) {
              dispatch({
                type: "ticket-failed",
                message: failure.retryable
                  ? { key: "Game.waitTimeout" }
                  : failure.message,
              });
              return;
            }
            waitMessage(failure.message);
            await sleep(failure.retryAfterMs);
          } finally {
            window.clearInterval(poller);
          }
          if (cancelled) {
            return;
          }
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        console.error(error);
        dispatch({
          type: "ticket-failed",
          message:
            error instanceof GameTabError
              ? error.appMessage
              : { key: "Game.ticketFailed" },
        });
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [room.id, state.ticketRequest]);

  // A frame that never reports readiness is an explicit error, not a spinner
  // forever.
  React.useEffect(() => {
    if (!exportReady) {
      return;
    }
    const timer = window.setTimeout(() => {
      dispatch({ type: "load-timeout", attempt });
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [attempt, exportReady]);

  // The ticket is only valid while the frame acknowledges it; once the frame
  // reported `configured`/`authenticated` the engine may take its time.
  React.useEffect(() => {
    if (phase !== "handshake" || state.acknowledged) {
      return;
    }
    const timer = window.setTimeout(() => {
      dispatch({ type: "handshake-timeout", attempt });
    }, HANDSHAKE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [attempt, phase, state.acknowledged]);

  // Backoff between reconnect attempts.
  React.useEffect(() => {
    if (phase !== "reconnecting") {
      return;
    }
    const delay = Math.min(1_000 * 2 ** (autoRetries - 1), 8_000);
    const timer = window.setTimeout(() => {
      dispatch({ type: "auto-retry" });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [autoRetries, phase]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) {
        return;
      }
      const data = event.data;
      if (!isGameMessage(data)) {
        return;
      }

      // Any valid message proves the engine loop is still alive.
      lastFrameMessageAtRef.current = Date.now();

      switch (data.type) {
        case "wired:game-booted":
          dispatch({ type: "booted" });
          break;
        case "wired:game-ready":
          dispatch({ type: "frame-ready" });
          break;
        case "wired:game-configured":
          dispatch({ type: "configured" });
          break;
        case "wired:game-status":
          dispatch({
            type: "status",
            stage: data.payload.stage,
            detail: data.payload.detail,
          });
          break;
        case "wired:game-error":
          dispatch({
            type: "game-error",
            message: data.payload.message
              ? { raw: data.payload.message }
              : { key: "Game.error" },
          });
          break;
        case "wired:game-event": {
          const value = data.payload.event;
          if (!value || typeof value !== "object") {
            break;
          }
          const typed = value as { type?: unknown; players?: unknown };
          if (typeof typed.type !== "string") {
            break;
          }
          dispatch({
            type: "event",
            name: typed.type,
            players: Array.isArray(typed.players)
              ? typed.players.length
              : undefined,
          });
          break;
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  React.useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getGameRoomStatus(room.id);
        if (!cancelled) {
          dispatch({ type: "players", count: status.activePlayers });
        }
      } catch {
        // Status is advisory; a failed poll must not tear down the game.
      }
    };
    void poll();
    const timer = window.setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, room.id]);

  // The status poll only proves the backend is healthy. A frame whose WASM
  // engine crashed silently keeps the tab in `ready` forever unless the host
  // asks the frame itself and notices the missing answers.
  React.useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    lastFrameMessageAtRef.current = Date.now();
    const timer = window.setInterval(() => {
      const frame = iframeRef.current;
      if (!frame) {
        return;
      }
      if (Date.now() - lastFrameMessageAtRef.current >= HEARTBEAT_TIMEOUT_MS) {
        dispatch({ type: "transport-lost" });
        return;
      }
      postGamePing(frame);
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [phase]);

  const retryNow = React.useCallback(() => {
    dispatch({ type: "retry" });
  }, []);

  return (
    <div
      className="relative w-full h-full bg-black text-white"
      onClick={focusFrame}
      tabIndex={-1}
    >
      {exportReady && (
        <iframe
          key={attempt}
          ref={iframeRef}
          src={EXPORT_URL}
          title="Wired game"
          className="absolute inset-0 w-full h-full border-0"
          allow="autoplay; fullscreen; gamepad"
          allowFullScreen
          onLoad={() => {
            const frame = iframeRef.current;
            if (frame) {
              postGamePing(frame);
            }
          }}
        />
      )}

      {phase !== "ready" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/80 px-6 text-center">
          {phase === "error" ? (
            <>
              <h2 className="text-xl font-semibold">{t("unavailable")}</h2>
              <p className="max-w-md text-sm text-white/70">{messageText}</p>
              <button
                type="button"
                onClick={retryNow}
                className="cursor-pointer rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-80"
              >
                {common("retry")}
              </button>
            </>
          ) : (
            <>
              <Spinner />
              <p className="max-w-md text-sm text-white/70">{messageText}</p>
              {phase === "reconnecting" && (
                <p className="text-xs text-white/50">
                  {t("autoAttempt", {
                    current: autoRetries,
                    total: MAX_AUTO_RETRIES,
                  })}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {phase === "ready" && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-md bg-black/60 px-3 py-1 text-xs">
          {t("players", { count: players })}
          {events.length > 0 && (
            <span className="ml-2 opacity-70">{events.at(-1)}</span>
          )}
        </div>
      )}
    </div>
  );
}
