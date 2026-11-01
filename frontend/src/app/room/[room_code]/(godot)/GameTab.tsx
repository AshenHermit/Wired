"use client";

import {
  Room,
  type GameRoomRuntimeStatus,
  type RoomPackagesStatus,
} from "@wired-io/shared";
import React from "react";
import {
  createGameConnection,
  getGameRoomStatus,
  getRoomPackages,
} from "@/api/services/godot-game";
import { Spinner } from "@/components/ui/spinner";
import { API_PREFIX } from "@/utils/variables";
import { readAccessToken } from "@/utils/auth-cookie";
import {
  type GameStatusStage,
  isGameMessage,
  postGameConfigure,
  postGamePing,
} from "./game-bridge";

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
// that instead of turning a normal startup into "Игра недоступна".
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
  message: string;
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

const INITIAL_STATE: GameState = {
  attempt: 0,
  exportReady: false,
  phase: "checking",
  message: "Проверяем сборку игры…",
  players: 0,
  events: [],
  autoRetries: 0,
  sentAttempt: null,
  ticketRequest: null,
  acknowledged: false,
};

type GameAction =
  | { type: "export-ready" }
  | { type: "export-failed"; message: string }
  | { type: "booted" }
  | { type: "frame-ready" }
  | { type: "configured-sent"; attempt: number }
  | { type: "configured" }
  | { type: "connection-wait"; attempt: number; message: string }
  | { type: "status"; stage: GameStatusStage; detail?: string }
  | { type: "game-error"; message: string }
  | { type: "event"; name: string; players?: number }
  | { type: "players"; count: number }
  | { type: "ticket-failed"; message: string }
  | { type: "handshake-timeout"; attempt: number }
  | { type: "load-timeout"; attempt: number }
  | { type: "transport-lost" }
  | { type: "auto-retry" }
  | { type: "retry" };

/** Stops the tab on a message and invalidates any in-flight ticket. */
function fail(state: GameState, message: string): GameState {
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
    return fail(
      state,
      "Соединение потеряно. Нажмите «Повторить», чтобы получить новый тикет.",
    );
  }
  const delay = Math.min(1_000 * 2 ** state.autoRetries, 8_000);
  return {
    ...state,
    phase: "reconnecting",
    message: `Соединение потеряно. Переподключение через ${Math.round(delay / 1_000)} с…`,
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
    message: "Проверяем сборку игры…",
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
        message: "Загружаем движок Godot…",
      };
    case "export-failed":
      return { ...fail(state, action.message), exportReady: false };
    case "booted":
      return state.phase === "error"
        ? state
        : {
            ...state,
            phase: "loading",
            message: "Движок Godot загружается…",
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
        message: "Запрашиваем подключение к комнате…",
      };
    case "configured-sent":
      if (state.ticketRequest !== action.attempt || state.phase === "error") {
        return state;
      }
      return {
        ...state,
        phase: "handshake",
        message: "Передаём тикет игре…",
        acknowledged: false,
      };
    case "configured":
      if (state.sentAttempt !== state.attempt || state.phase === "error") {
        return state;
      }
      return {
        ...state,
        phase: "handshake",
        message: "Тикет принят игрой…",
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
            message: "Подключаемся к серверу игры…",
          };
        case "authenticated":
          return {
            ...state,
            phase: "handshake",
            message: "Авторизация в комнате…",
            acknowledged: true,
          };
        case "ready":
          // "ready" means an authenticated, configured peer, never just a
          // booted engine. Ignore it before the ticket was sent.
          if (!sent) return state;
          return {
            ...state,
            phase: "ready",
            message: "Игра готова",
            autoRetries: 0,
          };
        case "connection_failed":
        case "disconnected":
          return startReconnect(state);
        case "error":
          return fail(state, action.detail || "Ошибка игры");
        default:
          return state;
      }
    }
    case "game-error":
      // Keep the first, actionable error: a frame that times out waiting for a
      // ticket must not overwrite the host's own startup error a minute later.
      if (state.phase === "error") return state;
      return fail(state, action.message || "Ошибка игры");
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
      return fail(
        state,
        "Игра не подтвердила подключение. Нажмите «Повторить», чтобы получить новый тикет.",
      );
    case "load-timeout":
      if (state.phase === "error" || state.sentAttempt === state.attempt) {
        return state;
      }
      return fail(
        state,
        "Игра не загрузилась за 2 минуты. Проверьте консоль и нажмите «Повторить».",
      );
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
const RETRYABLE_CONNECTION_CODES = new Set([
  "packages_pending",
  "room_stopping",
  "room_not_running",
  "handshake_window_expired",
]);

const CONNECTION_MESSAGE_BY_CODE: Record<string, string> = {
  packages_pending: "Применяем пакеты комнаты…",
  room_stopping: "Сервер игры перезапускается…",
  room_not_running: "Запускаем сервер игры…",
  handshake_window_expired: "Сервер игры перезапускается…",
};

const FATAL_CONNECTION_MESSAGE_BY_CODE: Record<string, string> = {
  packages_failed: "Не удалось применить пакеты комнаты. Нажмите «Повторить».",
  start_failed:
    "Сервер игры не смог запуститься. Проверьте логи backend и нажмите «Повторить».",
  config: "Сервер игры не настроен на этом backend.",
  ticket_secret_missing: "Сервер игры не настроен на этом backend.",
};

type ConnectionFailure = {
  retryable: boolean;
  message: string;
  retryAfterMs: number;
};

/** Keeps the structured backend `code` available to the retry loop. */
function describeConnectionFailure(error: unknown): ConnectionFailure {
  const response = (
    error as {
      response?: {
        status?: number;
        data?: { code?: unknown; retryAfterSeconds?: unknown };
      };
    }
  ).response;
  const data = response?.data;
  const code = typeof data?.code === "string" ? data.code : "";
  const fallback =
    error instanceof Error ? error.message : "Не удалось подключиться к игре";

  if (response?.status === 429) {
    const retryAfterSeconds = Number(data?.retryAfterSeconds);
    const seconds =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds
        : 5;
    return {
      retryable: true,
      message: `Слишком много попыток. Повторяем через ${seconds} с…`,
      retryAfterMs: seconds * 1_000,
    };
  }
  if (RETRYABLE_CONNECTION_CODES.has(code)) {
    return {
      retryable: true,
      message: CONNECTION_MESSAGE_BY_CODE[code] ?? "Сервер игры ещё запускается…",
      retryAfterMs: CONNECTION_RETRY_MS,
    };
  }
  return {
    retryable: false,
    message: FATAL_CONNECTION_MESSAGE_BY_CODE[code] ?? fallback,
    retryAfterMs: 0,
  };
}

/** Human-readable runtime stage shown while the ticket is being obtained. */
function runtimeMessage(
  status: GameRoomRuntimeStatus,
  packagesApplied: boolean,
  appliedPackages: number,
  totalPackages: number,
): string {
  switch (status.state) {
    case "starting":
      return "Сервер игры запускается…";
    case "stopping":
      return "Сервер игры перезапускается…";
    case "running":
      if (packagesApplied) return "Сервер игры готов. Запрашиваем подключение…";
      return totalPackages > 0
        ? `Применяем пакеты комнаты (${appliedPackages}/${totalPackages})…`
        : "Готовим мир комнаты…";
    case "failed":
      return "Сервер игры перезапускается…";
    default:
      return "Запускаем сервер игры…";
  }
}

export type ActivePackage = { packageId: number; revision: number };

/**
 * Packages that take part in the running game: an unpublished package has no
 * revision to apply and a disabled one is intentionally out of the room.
 */
export function activePackages(
  packages: RoomPackagesStatus,
): ActivePackage[] {
  return packages.packages
    .filter((entry) => entry.enabled && entry.revision > 0)
    .map(({ packageId, revision }) => ({ packageId, revision }));
}

export function packagesAreApplied(packages: RoomPackagesStatus): boolean {
  const active = activePackages(packages);
  if (active.length === 0) return true;
  return active.every(({ packageId, revision }) => {
    const status = packages.packages.find(
      (entry) => entry.packageId === packageId,
    );
    return (
      status?.runtime.state === "applied" &&
      status.runtime.revision >= revision
    );
  });
}

export function packagesFailed(packages: RoomPackagesStatus): boolean {
  const active = new Set(activePackages(packages).map(({ packageId }) => packageId));
  return packages.packages.some(
    (entry) => active.has(entry.packageId) && entry.runtime.state === "failed",
  );
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

  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const lastFrameMessageAtRef = React.useRef(0);

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
                ? "Сборка игры не найдена. Выполните pnpm export:game и нажмите «Повторить»."
                : `Не удалось загрузить игру (HTTP ${response.status}).`,
          });
          return;
        }
        dispatch({ type: "export-ready" });
      } catch {
        if (!cancelled) {
          dispatch({
            type: "export-failed",
            message:
              "Нет связи с сервером игры. Проверьте, что backend запущен.",
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
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, ms));

    const waitMessage = (message: string) => {
      if (!cancelled) {
        dispatch({ type: "connection-wait", attempt: request, message });
      }
    };

    const readRuntime = async () => {
      const [status, packages] = await Promise.all([
        getGameRoomStatus(room.id),
        getRoomPackages(room.id),
      ]);
      return { status, packages };
    };

    const describeRuntime = (
      status: GameRoomRuntimeStatus,
      packages: RoomPackagesStatus,
    ) => {
      const active = activePackages(packages);
      const total = active.length;
      const applied = active.filter(({ packageId, revision }) => {
        const entry = packages.packages.find(
          (pkg) => pkg.packageId === packageId,
        );
        return (
          entry?.runtime.state === "applied" &&
          entry.runtime.revision >= revision
        );
      }).length;
      waitMessage(
        runtimeMessage(status, packagesAreApplied(packages), applied, total),
      );
    };

    const waitForRuntime = async (deadline: number) => {
      for (;;) {
        const { status, packages } = await readRuntime();
        describeRuntime(status, packages);
        if (cancelled) return;
        if (packagesFailed(packages)) {
          throw new Error(
            "Не удалось применить пакеты комнаты. Нажмите «Повторить».",
          );
        }
        if (status.state === "running" && packagesAreApplied(packages)) return;
        // Idle, stopped and crashed runtimes are all restarted by the POST
        // below. Only `starting`/`stopping` and package application are states
        // this loop has to wait out.
        if (
          status.state === "idle" ||
          status.state === "stopped" ||
          status.state === "failed"
        ) {
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            "Сервер игры не запустился за 90 секунд. Нажмите «Повторить».",
          );
        }
        await sleep(RUNTIME_POLL_MS);
        if (cancelled) return;
      }
    };

    void (async () => {
      const deadline = Date.now() + CONNECTION_WAIT_MS;
      try {
        for (;;) {
          await waitForRuntime(deadline);
          if (cancelled) return;

          // The POST is what starts a stopped runtime and waits for its first
          // package pass. Keep the overlay informative while it is in flight.
          const poller = window.setInterval(() => {
            void readRuntime()
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
                message: "Фрейм игры не готов. Нажмите «Повторить».",
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
                  ? "Сервер игры не запустился за 90 секунд. Нажмите «Повторить»."
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
        dispatch({
          type: "ticket-failed",
          message:
            error instanceof Error
              ? error.message
              : "Не удалось получить доступ к игре",
        });
      }
    })();

    return () => {
      cancelled = true;
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
            message: data.payload.message || "Ошибка игры",
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
    <div className="relative w-full h-full bg-black text-white">
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
              <h2 className="text-xl font-semibold">Игра недоступна</h2>
              <p className="max-w-md text-sm text-white/70">{message}</p>
              <button
                type="button"
                onClick={retryNow}
                className="cursor-pointer rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-80"
              >
                Повторить
              </button>
            </>
          ) : (
            <>
              <Spinner />
              <p className="max-w-md text-sm text-white/70">{message}</p>
              {phase === "reconnecting" && (
                <p className="text-xs text-white/50">
                  Автоматическая попытка {autoRetries} из {MAX_AUTO_RETRIES}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {phase === "ready" && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-md bg-black/60 px-3 py-1 text-xs">
          Игроков: {players}
          {events.length > 0 && (
            <span className="ml-2 opacity-70">· {events.at(-1)}</span>
          )}
        </div>
      )}
    </div>
  );
}
