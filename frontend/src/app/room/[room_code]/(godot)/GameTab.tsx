"use client";

import { Room } from "@wired-io/shared";
import React from "react";
import {
  createGameConnection,
  getGameRoomStatus,
} from "@/api/services/godot-game";
import { Spinner } from "@/components/ui/spinner";
import {
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

const EXPORT_URL = "/api/game-export/index.html";
const MAX_AUTO_RETRIES = 3;
// The engine bundle is ~36 MB, so a cold load on a slow link can take far
// longer than 30 seconds. Export assets are revalidated with ETags, so this
// only affects the first load of a build, not reconnects.
const LOAD_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const STATUS_POLL_MS = 5_000;

/**
 * The Godot Web build runs in a same-origin iframe. The host waits for the
 * engine to boot, requests a fresh single-use ticket, and hands it over with
 * postMessage. A reconnect reloads the iframe, which is the only way to get a
 * clean engine instance and a new handshake on this protocol version.
 */
export function GameTab({ room }: { room: Room }) {
  const [attempt, setAttempt] = React.useState(0);
  const [exportReady, setExportReady] = React.useState(false);
  const [phase, setPhase] = React.useState<GamePhase>("checking");
  const [message, setMessage] = React.useState("Проверяем сборку игры…");
  const [players, setPlayers] = React.useState(0);
  const [events, setEvents] = React.useState<string[]>([]);
  const [autoRetries, setAutoRetries] = React.useState(0);

  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const phaseRef = React.useRef<GamePhase>("checking");
  const sentAttemptRef = React.useRef(-1);
  const autoRetriesRef = React.useRef(0);
  const retryTimerRef = React.useRef<number | null>(null);
  const handshakeTimerRef = React.useRef<number | null>(null);
  const disposedRef = React.useRef(false);

  const update = React.useCallback((next: GamePhase, text?: string) => {
    phaseRef.current = next;
    setPhase(next);
    if (text !== undefined) {
      setMessage(text);
    }
  }, []);

  const clearHandshakeTimer = React.useCallback(() => {
    if (handshakeTimerRef.current !== null) {
      window.clearTimeout(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
    }
  }, []);

  const fail = React.useCallback(
    (text: string) => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      clearHandshakeTimer();
      update("error", text);
    },
    [clearHandshakeTimer, update],
  );

  const startReconnect = React.useCallback(() => {
    if (phaseRef.current === "error" || retryTimerRef.current !== null) {
      return;
    }
    if (autoRetriesRef.current >= MAX_AUTO_RETRIES) {
      fail("Соединение потеряно. Нажмите «Повторить», чтобы получить новый тикет.");
      return;
    }
    const delay = Math.min(1_000 * 2 ** autoRetriesRef.current, 8_000);
    autoRetriesRef.current += 1;
    setAutoRetries(autoRetriesRef.current);
    update(
      "reconnecting",
      `Соединение потеряно. Переподключение через ${Math.round(delay / 1_000)} с…`,
    );
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      if (!disposedRef.current) {
        setAttempt((value) => value + 1);
      }
    }, delay);
  }, [fail, update]);

  const requestConnection = React.useCallback(async () => {
    const attemptAtStart = attempt;
    try {
      update("requesting", "Запрашиваем подключение к комнате…");
      const connection = await createGameConnection(room.id);
      if (
        disposedRef.current ||
        attemptAtStart !== attempt ||
        phaseRef.current === "error"
      ) {
        // The frame already gave up (or was replaced) while the request was
        // in flight: never resurrect an errored frame with a stale ticket.
        return;
      }
      const frame = iframeRef.current;
      if (!frame?.contentWindow) {
        fail("Фрейм игры не готов. Нажмите «Повторить».");
        return;
      }
      update("handshake", "Передаём тикет игре…");
      postGameConfigure(frame, {
        endpoint: connection.endpoint,
        ticket: connection.ticket,
        room: connection.roomId,
      });
      clearHandshakeTimer();
      handshakeTimerRef.current = window.setTimeout(() => {
        handshakeTimerRef.current = null;
        if (
          !disposedRef.current &&
          attemptAtStart === attempt &&
          phaseRef.current === "handshake"
        ) {
          fail(
            "Игра не подтвердила подключение. Нажмите «Повторить», чтобы получить новый тикет.",
          );
        }
      }, HANDSHAKE_TIMEOUT_MS);
    } catch (error) {
      if (attemptAtStart !== attempt || disposedRef.current) {
        return;
      }
      fail(
        error instanceof Error
          ? error.message
          : "Не удалось получить доступ к игре",
      );
    }
  }, [attempt, clearHandshakeTimer, fail, room.id, update]);

  const addEvent = React.useCallback((event: unknown) => {
    if (!event || typeof event !== "object") {
      return;
    }
    const value = event as { type?: unknown; players?: unknown };
    if (typeof value.type !== "string") {
      return;
    }
    setEvents((previous) => [...previous.slice(-3), value.type as string]);
    if (value.type === "world_state" && Array.isArray(value.players)) {
      setPlayers(value.players.length);
    }
  }, []);

  // Verify the export exists before mounting the frame, so an unbuilt export
  // produces an actionable message instead of a silent blank iframe.
  React.useEffect(() => {
    let cancelled = false;
    setExportReady(false);
    update("checking", "Проверяем сборку игры…");

    void (async () => {
      try {
        const response = await fetch(EXPORT_URL, { cache: "no-store" });
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          update(
            "error",
            response.status === 404
              ? "Сборка игры не найдена. Выполните pnpm export:game и нажмите «Повторить»."
              : `Не удалось загрузить игру (HTTP ${response.status}).`,
          );
          return;
        }
        setExportReady(true);
        update("loading", "Загружаем движок Godot…");
      } catch {
        if (!cancelled) {
          update(
            "error",
            "Нет связи с сервером игры. Проверьте, что backend запущен.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt, update]);

  // A frame that never reports readiness is an explicit error, not a spinner
  // forever.
  React.useEffect(() => {
    if (!exportReady) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (sentAttemptRef.current !== attempt) {
        update(
          "error",
          "Игра не загрузилась за 2 минуты. Проверьте консоль и нажмите «Повторить».",
        );
      }
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [attempt, exportReady, update]);

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

      switch (data.type) {
        case "wired:game-booted":
          if (phaseRef.current !== "error") {
            update("loading", "Движок Godot загружается…");
          }
          break;
        case "wired:game-ready": {
          // A frame that already errored (for example, its config wait
          // elapsed) must not mint another ticket during a retry: only the
          // retry button may replace the frame.
          if (
            phaseRef.current === "error" ||
            sentAttemptRef.current === attempt
          ) {
            break;
          }
          sentAttemptRef.current = attempt;
          void requestConnection();
          break;
        }
        case "wired:game-configured":
          if (sentAttemptRef.current === attempt) {
            clearHandshakeTimer();
            update("handshake", "Тикет принят игрой…");
          }
          break;
        case "wired:game-status": {
          const stage = data.payload.stage;
          const detail = data.payload.detail;
          if (stage === "booted") {
            // The engine script is loaded, but the game is not joined yet.
            break;
          } else if (stage === "waiting" || stage === "connecting") {
            update("handshake", "Подключаемся к серверу игры…");
          } else if (stage === "authenticated") {
            clearHandshakeTimer();
            update("handshake", "Авторизация в комнате…");
          } else if (stage === "ready") {
            // "ready" means an authenticated, configured peer, never just a
            // booted engine. Ignore it before the ticket was sent.
            if (
              sentAttemptRef.current !== attempt ||
              phaseRef.current === "error"
            ) {
              break;
            }
            clearHandshakeTimer();
            autoRetriesRef.current = 0;
            setAutoRetries(0);
            update("ready", "Игра готова");
          } else if (
            stage === "connection_failed" ||
            stage === "disconnected"
          ) {
            clearHandshakeTimer();
            startReconnect();
          } else if (stage === "error") {
            fail(detail || "Ошибка игры");
          }
          break;
        }
        case "wired:game-error":
          fail(data.payload.message || "Ошибка игры");
          break;
        case "wired:game-event":
          addEvent(data.payload.event);
          break;
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    addEvent,
    attempt,
    clearHandshakeTimer,
    fail,
    requestConnection,
    startReconnect,
    update,
  ]);

  React.useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getGameRoomStatus(room.id);
        if (!cancelled) {
          setPlayers(status.activePlayers);
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

  React.useEffect(() => {
    // Strict Mode runs setup → cleanup → setup on the same instance in
    // development. Reset the flag so the second setup is not treated as a
    // disposed component and every connection request is dropped.
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
      if (handshakeTimerRef.current !== null) {
        window.clearTimeout(handshakeTimerRef.current);
      }
    };
  }, []);

  const retryNow = React.useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    clearHandshakeTimer();
    autoRetriesRef.current = 0;
    setAutoRetries(0);
    setEvents([]);
    update("checking", "Проверяем сборку игры…");
    setAttempt((value) => value + 1);
  }, [clearHandshakeTimer, update]);

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
