import { act, render, screen, waitFor } from "@testing-library/react";
import type { Room, RoomPackagesStatus } from "@wired-io/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntlProvider,
  renderWithIntl,
} from "@/test/render-with-intl";
import {
  createGameConnection,
  getGameRoomStatus,
  getRoomPackages,
} from "@/api/services/godot-game";
import {
  GameTab,
  activePackages,
  packagesAreApplied,
  packagesFailed,
} from "./GameTab";
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

function apiError(status: number, code: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: {
      status,
      data: { statusCode: status, code, message: code },
    },
  });
}

function packageStatus(
  runtimeState: "pending" | "applied" | "failed",
): RoomPackagesStatus {
  return {
    roomId: 8,
    packages: [
      {
        packageId: 20,
        slug: "platformer",
        name: "Platformer",
        enabled: true,
        revision: 2,
        publishedAt: "2026-01-01T00:00:00.000Z",
        state: "published",
        runtime: {
          state: runtimeState,
          revision: 2,
          error: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        clients: [],
      },
    ],
  };
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
  const view = renderWithIntl(<GameTab room={room} />);
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
async function reachReady(view: ReturnType<typeof renderWithIntl>) {
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
    vi.mocked(getRoomPackages).mockResolvedValue(packageStatus("applied"));
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

  it("retranslates the current status without replacing the frame", async () => {
    const view = render(
      <IntlProvider locale="ru">
        <GameTab room={room} />
      </IntlProvider>,
    );
    await waitFor(() => {
      expect(view.container.querySelector("iframe")).not.toBeNull();
    });

    expect(view.getByText("Загружаем движок Godot…")).toBeTruthy();
    const frame = view.container.querySelector("iframe");

    view.rerender(
      <IntlProvider locale="en">
        <GameTab room={room} />
      </IntlProvider>,
    );

    expect(view.getByText("Loading the Godot engine…")).toBeTruthy();
    expect(view.container.querySelector("iframe")).toBe(frame);
  });

  it("falls back to a translated error when the payload has no message", async () => {
    const { iframe } = await mountGame();

    act(() => {
      send(iframe, {
        source: "wired-game",
        type: "wired:game-error",
        payload: { message: "" },
      });
    });

    expect(await screen.findByText("Игра недоступна")).toBeTruthy();
    expect(screen.getByText("Ошибка игры")).toBeTruthy();
  });

  it("renders markup from a game payload as text", async () => {
    const { iframe } = await mountGame();

    act(() => {
      send(iframe, {
        source: "wired-game",
        type: "wired:game-error",
        payload: { message: "<b>boom</b>" },
      });
    });

    expect(await screen.findByText("<b>boom</b>")).toBeTruthy();
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
      const view = renderWithIntl(<GameTab room={room} />);
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
      const view = renderWithIntl(<GameTab room={room} />);
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

  it("shows a cold runtime start and waits for it before asking for a ticket", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getGameRoomStatus).mockResolvedValue({
        roomId: 8,
        state: "starting",
        endpoint: null,
        activePlayers: 0,
        error: null,
      });
      const view = renderWithIntl(<GameTab room={room} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const iframe = view.container.querySelector("iframe") as HTMLIFrameElement;

      send(iframe, {
        source: "wired-game",
        type: "wired:game-ready",
        payload: {},
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(view.container.textContent).toContain("Сервер игры запускается…");
      expect(createGameConnection).not.toHaveBeenCalled();

      vi.mocked(getGameRoomStatus).mockResolvedValue({
        roomId: 8,
        state: "running",
        endpoint: "ws://127.0.0.1:19100",
        activePlayers: 0,
        error: null,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(createGameConnection).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats packages still applying as a wait, not as a fatal error", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(createGameConnection)
        .mockRejectedValueOnce(apiError(409, "packages_pending"))
        .mockResolvedValue(connection);
      const view = renderWithIntl(<GameTab room={room} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const iframe = view.container.querySelector("iframe") as HTMLIFrameElement;
      send(iframe, {
        source: "wired-game",
        type: "wired:game-ready",
        payload: {},
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(view.container.textContent).toContain("Применяем пакеты комнаты…");
      expect(view.container.textContent).not.toContain("Игра недоступна");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(createGameConnection).toHaveBeenCalledTimes(2);
      expect(view.container.textContent).not.toContain("Игра недоступна");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pings a live ready frame and keeps it mounted", async () => {
    vi.useFakeTimers();
    try {
      const view = renderWithIntl(<GameTab room={room} />);
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

function statusOf(
  packages: RoomPackagesStatus["packages"],
): RoomPackagesStatus {
  return { roomId: 8, packages };
}

function pkg(
  overrides: Partial<RoomPackagesStatus["packages"][number]> = {},
): RoomPackagesStatus["packages"][number] {
  return {
    packageId: 1,
    slug: "package",
    name: "Package",
    enabled: true,
    revision: 1,
    publishedAt: null,
    state: "published",
    runtime: {
      state: "pending",
      revision: 1,
      error: null,
      updatedAt: null,
    },
    clients: [],
    ...overrides,
  };
}

describe("package readiness helpers", () => {
  it("ignores disabled and unpublished packages when judging readiness", () => {
    const status = statusOf([
      pkg({ packageId: 1, enabled: false, revision: 3 }),
      pkg({ packageId: 2, enabled: true, revision: 0 }),
    ]);

    expect(packagesAreApplied(status)).toBe(true);
    expect(packagesFailed(status)).toBe(false);
  });

  it("passes only enabled published packages to the bridge config", () => {
    expect(
      activePackages(
        statusOf([
          pkg({ packageId: 1, enabled: false, revision: 3 }),
          pkg({ packageId: 2, enabled: true, revision: 0 }),
          pkg({ packageId: 3, enabled: true, revision: 4 }),
        ]),
      ),
    ).toEqual([{ packageId: 3, revision: 4 }]);
  });

  it("keeps a package pending while the runtime is on an older revision", () => {
    const status = statusOf([
      pkg({
        packageId: 3,
        revision: 4,
        runtime: {
          state: "applied",
          revision: 3,
          error: null,
          updatedAt: null,
        },
      }),
    ]);

    expect(packagesAreApplied(status)).toBe(false);
    expect(packagesFailed(status)).toBe(false);
  });

  it("reports failure only for active packages", () => {
    const status = statusOf([
      pkg({
        packageId: 1,
        enabled: false,
        revision: 3,
        runtime: {
          state: "failed",
          revision: 3,
          error: "boom",
          updatedAt: null,
        },
      }),
    ]);

    expect(packagesFailed(status)).toBe(false);
  });
});
