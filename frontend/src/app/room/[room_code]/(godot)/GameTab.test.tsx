import { render, screen, waitFor } from "@testing-library/react";
import type { Room } from "@wired-io/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGameConnection,
  getGameRoomStatus,
} from "@/api/services/godot-game";
import { GameTab } from "./GameTab";

vi.mock("@/api/services/godot-game", () => ({
  createGameConnection: vi.fn(),
  getGameRoomStatus: vi.fn(),
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

describe("GameTab bridge", () => {
  beforeEach(() => {
    vi.mocked(createGameConnection).mockReset();
    vi.mocked(getGameRoomStatus).mockReset();
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
});
