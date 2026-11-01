import { act, render, screen, waitFor } from "@testing-library/react";
import type { Room, RoomPackagesStatus } from "@wired-io/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGameConnection,
  getGameRoomStatus,
  getRoomPackages,
} from "@/api/services/godot-game";
import { GameTab } from "./GameTab";

vi.mock("@/api/services/godot-game", () => ({
  createGameConnection: vi.fn(),
  getGameRoomStatus: vi.fn(),
  getRoomPackages: vi.fn(),
}));

const room = { id: 8 } as Room;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function send(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: window.location.origin,
      source: iframe.contentWindow as unknown as MessageEventSource,
    }),
  );
}

async function mountGame() {
  const view = render(<GameTab room={room} />);
  const iframe = await waitFor(() => {
    const element = view.container.querySelector("iframe");
    if (!element) {
      throw new Error("iframe is not mounted yet");
    }
    return element as HTMLIFrameElement;
  });
  return { ...view, iframe };
}

const connection = {
  roomId: 8,
  endpoint: "ws://127.0.0.1:19100",
  ticket: "one-time-ticket",
  ticketExpiresAt: 1_800_000_000,
  activePlayers: 0,
};

/**
 * Drives the host through the whole handshake with fake timers. Mirrors what
 * the exported build sends, so the heartbeat can be observed from `ready`.
 */
async function reachReady(view: ReturnType<typeof render>) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const iframe = view.container.querySelector("iframe") as HTMLIFrameElement;
  if (!iframe) {
    throw new Error("iframe is not mounted");
  }
  send(iframe, { source: "wired-game", type: "wired:game-ready", payload: {} });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  send(iframe, {
    source: "wired-game",
    type: "wired:game-configured",
    payload: { room: 8 },
  });
  send(iframe, {
    source: "wired-game",
    type: "wired:game-status",
    payload: { stage: "authenticated", detail: "" },
  });
  send(iframe, {
    source: "wired-game",
    type: "wired:game-status",
    payload: { stage: "ready", detail: "" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return iframe;
}

describe("GameTab bridge", () => {
  beforeEach(() => {
    vi.mocked(createGameConnection).mockReset();
    vi.mocked(createGameConnection).mockResolvedValue(connection);
    vi.mocked(getGameRoomStatus).mockReset();
    vi.mocked(getRoomPackages).mockReset();
    vi.mocked(getRoomPackages).mockResolvedValue({
      roomId: 8,
      packages: [{ packageId: 20, revision: 2 }],
    } as unknown as RoomPackagesStatus);
    vi.mocked(getGameRoomStatus).mockResolvedValue({
      roomId: 8,
      state: "running",
      endpoint: "ws://127.0.0.1:19100",
      activePlayers: 1,
      error: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests one ticket per ready frame and notifies the frame only once", async () => {
    const request = deferred<typeof connection>();
    vi.mocked(createGameConnection).mockReturnValue(request.promise);
    const { container, iframe } = await mountGame();
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    send(iframe, { source: "wired-game", type: "wired:game-ready", payload: {} });
    send(iframe, { source: "wired-game", type: "wired:game-ready", payload: {} });

    await waitFor(() => {
      expect(createGameConnection).toHaveBeenCalledTimes(1);
    });

    request.resolve(connection);
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "wired-host",
          type: "wired:configure",
          payload: expect.objectContaining({
            ticket: "one-time-ticket",
            apiBase: `${window.location.origin}/api`,
            apiToken: expect.any(String),
            packages: [{ packageId: 20, revision: 2 }],
          }),
        }),
        window.location.origin,
      );
    });

    send(iframe, {
      source: "wired-game",
      type: "wired:game-configured",
      payload: { room: 8 },
    });
    send(iframe, {
      source: "wired-game",
      type: "wired:game-status",
      payload: { stage: "authenticated", detail: "" },
    });
    send(iframe, {
      source: "wired-game",
      type: "wired:game-status",
      payload: { stage: "ready", detail: "" },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Игроков: 1");
    });
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("does not treat a booted engine as a joined game", async () => {
    vi.mocked(createGameConnection).mockReturnValue(
      new Promise<typeof connection>(() => undefined),
    );
    const { container, iframe } = await mountGame();

    send(iframe, {
      source: "wired-game",
      type: "wired:game-status",
      payload: { stage: "ready", detail: "" },
    });

    expect(container.textContent).not.toContain("Игра готова");
    expect(createGameConnection).not.toHaveBeenCalled();
  });

  it("drops a late ticket after the frame already failed", async () => {
    const request = deferred<typeof connection>();
    vi.mocked(createGameConnection).mockReturnValue(request.promise);
    const { iframe } = await mountGame();
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    send(iframe, { source: "wired-game", type: "wired:game-ready", payload: {} });
    await waitFor(() => {
      expect(createGameConnection).toHaveBeenCalledTimes(1);
    });

    send(iframe, {
      source: "wired-game",
      type: "wired:game-error",
      payload: { message: "engine stopped" },
    });
    await screen.findByText("Игра недоступна");

    request.resolve(connection);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "wired:configure" }),
      window.location.origin,
    );
    expect(screen.getByText("Игра недоступна")).toBeTruthy();
  });

  it("reloads a ready frame whose engine stopped answering", async () => {
    vi.useFakeTimers();
    try {
      const view = render(<GameTab room={room} />);
      const iframe = await reachReady(view);
      expect(view.container.textContent).toContain("Игроков: 1");

      // No message from the frame for the whole heartbeat window: the backend
      // poll keeps succeeding, but the host must stop trusting the engine.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(view.container.textContent).not.toContain("Игроков: 1");
      expect(view.container.textContent).toContain("Соединение потеряно");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(view.container.querySelector("iframe")).not.toBe(iframe);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after three automatic reconnects", async () => {
    vi.useFakeTimers();
    try {
      const view = render(<GameTab room={room} />);
      let iframe = await reachReady(view);

      for (let autoRetry = 1; autoRetry <= 3; autoRetry += 1) {
        send(iframe, {
          source: "wired-game",
          type: "wired:game-status",
          payload: { stage: "disconnected", detail: "" },
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(view.container.textContent).toContain(
          `Автоматическая попытка ${autoRetry} из 3`,
        );

        // The backoff reloads the frame, but it never rejoins.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2 ** (autoRetry - 1) * 1_000);
        });
        const reloaded = view.container.querySelector("iframe");
        expect(reloaded).not.toBeNull();
        iframe = reloaded as HTMLIFrameElement;
      }

      send(iframe, {
        source: "wired-game",
        type: "wired:game-status",
        payload: { stage: "disconnected", detail: "" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(view.container.textContent).toContain("Игра недоступна");
      expect(view.container.textContent).toContain("Соединение потеряно");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pings a live ready frame and keeps it mounted", async () => {
    vi.useFakeTimers();
    try {
      const view = render(<GameTab room={room} />);
      const iframe = await reachReady(view);
      const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

      // The frame answers every heartbeat by reporting its still-ready stage.
      for (let beat = 0; beat < 4; beat += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        send(iframe, {
          source: "wired-game",
          type: "wired:game-status",
          payload: { stage: "ready", detail: "" },
        });
      }

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ source: "wired-host", type: "wired:ping" }),
        window.location.origin,
      );
      expect(view.container.querySelector("iframe")).toBe(iframe);
      expect(view.container.textContent).toContain("Игроков: 1");
      expect(view.container.textContent).not.toContain("Соединение потеряно");
    } finally {
      vi.useRealTimers();
    }
  });
});
