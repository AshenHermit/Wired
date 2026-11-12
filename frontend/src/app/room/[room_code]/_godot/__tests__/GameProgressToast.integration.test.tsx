import { act } from "@testing-library/react";
import type { Room, RoomPackagesStatus } from "@wired-io/shared";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGameConnection,
  getGameRoomStatus,
  getRoomPackages,
} from "@/api/services/godot-game";
import {
  bridgeEvents,
  emitPackageProgress,
  type PackageProgressEvent,
} from "@/lib/editorBridgeEvents";
import { renderWithIntl } from "@/test/render-with-intl";
import { GameTab } from "../GameTab";
import { GameProgressToast, packageToastId } from "../GameProgressToast";

// Only the Sonner surface is faked: the integration under test is the real
// bridge emitter feeding the real component, so nothing else may be mocked for
// the toast cases below.
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "loading-toast"),
    success: vi.fn(() => "success-toast"),
    error: vi.fn(() => "error-toast"),
  },
}));

// The Game tab case still needs the backend to be inert; the bridge and the
// toast listener stay real.
vi.mock("@/api/services/godot-game", () => ({
  createGameConnection: vi.fn(),
  getGameRoomStatus: vi.fn(),
  getRoomPackages: vi.fn(),
}));

const platformer: PackageProgressEvent = {
  packageId: "20",
  name: "Platformer",
  percent: 42,
  status: "loading",
};

const dialogue: PackageProgressEvent = {
  packageId: "30",
  name: "Dialogue",
  percent: 8,
  status: "loading",
};

function renderToast() {
  return renderWithIntl(<GameProgressToast />, { locale: "en" });
}

/** Renders a toast description so its text and attributes can be asserted. */
function markup(node: ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

function descriptionOf(call: unknown[] | undefined): string {
  const options = call?.[1] as { description?: ReactNode } | undefined;
  return markup(options?.description ?? null);
}

function toastOptions(call: unknown[] | undefined): Record<string, unknown> {
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(toast.loading).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  // The emitter is a process-wide singleton, so a listener left behind by a
  // failed assertion must not leak into the next case.
  bridgeEvents.all.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GameProgressToast integration", () => {
  it("stays silent until the bridge reports a package", () => {
    renderToast();

    expect(toast.loading).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("gives two packages two independent loading toasts", () => {
    renderToast();

    act(() => {
      emitPackageProgress(platformer);
      emitPackageProgress(dialogue);
    });

    expect(toast.loading).toHaveBeenCalledTimes(2);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    const calls = vi.mocked(toast.loading).mock.calls;
    const [platformerCall, dialogueCall] = calls as [
      [string, Record<string, unknown>],
      [string, Record<string, unknown>],
    ];

    expect(platformerCall[0]).toContain("Platformer");
    expect(dialogueCall[0]).toContain("Dialogue");
    expect(toastOptions(platformerCall).id).toBe(packageToastId("20"));
    expect(toastOptions(dialogueCall).id).toBe(packageToastId("30"));
    // Distinct packages must never collapse into one stack slot.
    expect(toastOptions(platformerCall).id).not.toBe(
      toastOptions(dialogueCall).id,
    );
    // Loading toasts have to stay until the bridge says otherwise.
    expect(toastOptions(platformerCall).duration).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(descriptionOf(platformerCall)).toContain("42%");
    expect(descriptionOf(dialogueCall)).toContain("8%");
  });

  it("replaces a package's loading toast with a self-dismissing success", () => {
    renderToast();

    act(() => {
      emitPackageProgress(platformer);
    });
    const loadingId = toastOptions(
      vi.mocked(toast.loading).mock.calls.at(-1),
    ).id;

    act(() => {
      emitPackageProgress({ ...platformer, percent: 100, status: "complete" });
    });

    expect(toast.success).toHaveBeenCalledTimes(1);
    const successCall = vi.mocked(toast.success).mock.calls[0];
    expect(successCall[0]).toContain("Platformer");
    expect(toastOptions(successCall).id).toBe(loadingId);
    expect(toastOptions(successCall).duration).toBe(5_000);
    expect(descriptionOf(successCall)).toContain("100%");
  });

  it("keeps a failed package on screen with the runtime's error message", () => {
    renderToast();

    act(() => {
      emitPackageProgress({
        packageId: "40",
        name: "Inventory",
        percent: 0,
        status: "error",
        errorMessage: "script error: inventory.gd:12",
      });
    });

    // `emitPackageProgress` routes failures to the error channel, so no
    // loading toast may be started for them.
    expect(toast.loading).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);

    const errorCall = vi.mocked(toast.error).mock.calls[0];
    expect(errorCall[0]).toContain("Inventory");
    expect(toastOptions(errorCall).id).toBe(packageToastId("40"));
    expect(toastOptions(errorCall).duration).toBe(Number.POSITIVE_INFINITY);
    expect(descriptionOf(errorCall)).toContain(
      "script error: inventory.gd:12",
    );
  });

  it("stops listening to the bridge after it unmounts", () => {
    const { unmount } = renderToast();

    act(() => {
      emitPackageProgress(platformer);
    });
    expect(toast.loading).toHaveBeenCalledTimes(1);

    unmount();

    act(() => {
      emitPackageProgress(dialogue);
      emitPackageProgress({ ...platformer, percent: 100, status: "complete" });
      emitPackageProgress({
        packageId: "40",
        name: "Inventory",
        percent: 0,
        status: "error",
        errorMessage: "too late",
      });
    });

    expect(toast.loading).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

const connection = {
  roomId: 8,
  endpoint: "ws://127.0.0.1:19100",
  ticket: "one-time-ticket",
  ticketExpiresAt: 1_800_000_000,
  activePlayers: 0,
};

const room = { id: 8 } as Room;

const runningStatus = {
  roomId: 8,
  state: "running" as const,
  endpoint: "ws://127.0.0.1:19100",
  activePlayers: 0,
  error: null,
};

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
        sizeBytes: null,
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

describe("GameTab package progress integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createGameConnection).mockReset();
    vi.mocked(createGameConnection).mockResolvedValue(connection);
    vi.mocked(getGameRoomStatus).mockReset();
    vi.mocked(getGameRoomStatus).mockResolvedValue(runningStatus);
    vi.mocked(getRoomPackages).mockReset();
    vi.mocked(getRoomPackages).mockResolvedValue(packageStatus("pending"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  it("turns the runtime package poll into a real loading toast", async () => {
    const view = renderWithIntl(<GameTab room={room} />, { locale: "en" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const iframe = view.container.querySelector("iframe");
    expect(iframe).not.toBeNull();

    act(() => {
      send(iframe as HTMLIFrameElement, {
        source: "wired-game",
        type: "wired:game-ready",
        payload: {},
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // No bridge mock here: the tab's runtime poll emitted into the shared
    // emitter and the mounted GameProgressToast turned it into a toast.
    expect(getRoomPackages).toHaveBeenCalled();
    expect(toast.loading).toHaveBeenCalledWith(
      expect.stringContaining("Platformer"),
      expect.objectContaining({
        id: packageToastId("20"),
        duration: Number.POSITIVE_INFINITY,
      }),
    );
  });
});
