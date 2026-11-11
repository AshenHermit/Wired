import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bridgeEvents,
  emitPackageProgress,
  type PackageProgressEvent,
} from "@/lib/editorBridgeEvents";
import { IntlProvider } from "@/test/render-with-intl";
import { GameProgressToast, packageToastId } from "./GameProgressToast";

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "loading-toast"),
    success: vi.fn(() => "success-toast"),
    error: vi.fn(() => "error-toast"),
  },
}));

const progress: PackageProgressEvent = {
  packageId: "20",
  name: "Platformer",
  percent: 42,
  status: "loading",
};

/** Renders a toast description so its text and attributes can be asserted. */
function markup(node: ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

function descriptionOf(call: unknown[] | undefined): string {
  const options = call?.[1] as { description?: ReactNode } | undefined;
  return markup(options?.description ?? null);
}

function renderToast() {
  return render(
    <IntlProvider locale="en">
      <GameProgressToast />
    </IntlProvider>,
  );
}

beforeEach(() => {
  vi.mocked(toast.loading).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  bridgeEvents.all.clear();
});

describe("GameProgressToast", () => {
  it("shows one progress toast per package id while a package loads", () => {
    renderToast();

    act(() => {
      emitPackageProgress(progress);
    });

    expect(toast.loading).toHaveBeenCalledWith(
      expect.stringContaining("Platformer"),
      expect.objectContaining({
        id: packageToastId("20"),
        duration: Number.POSITIVE_INFINITY,
      }),
    );
    expect(descriptionOf(vi.mocked(toast.loading).mock.calls[0])).toContain(
      "42%",
    );

    act(() => {
      emitPackageProgress({ ...progress, percent: 90 });
    });

    // The same id replaces the existing toast instead of stacking a new one.
    expect(toast.loading).toHaveBeenCalledTimes(2);
    expect(vi.mocked(toast.loading).mock.calls[1][1]).toEqual(
      expect.objectContaining({ id: packageToastId("20") }),
    );
    expect(descriptionOf(vi.mocked(toast.loading).mock.calls[1])).toContain(
      "90%",
    );
  });

  it("turns a finished package into a toast that dismisses itself", () => {
    renderToast();

    act(() => {
      emitPackageProgress({ ...progress, percent: 100, status: "complete" });
    });

    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("Platformer"),
      expect.objectContaining({ id: packageToastId("20"), duration: 5_000 }),
    );
    expect(descriptionOf(vi.mocked(toast.success).mock.calls[0])).toContain(
      "100%",
    );
    expect(toast.loading).not.toHaveBeenCalled();
  });

  it("keeps a failed package on screen with its error message", () => {
    renderToast();

    act(() => {
      emitPackageProgress({
        ...progress,
        percent: 0,
        status: "error",
        errorMessage: "Package Platformer: cannot stage main.gd: disk full",
      });
    });

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Platformer"),
      expect.objectContaining({
        id: packageToastId("20"),
        duration: Number.POSITIVE_INFINITY,
      }),
    );
    const description = descriptionOf(vi.mocked(toast.error).mock.calls[0]);
    expect(description).toContain("cannot stage main.gd: disk full");
    expect(description).toContain("text-destructive");
  });

  it("falls back to the translated package failure text", () => {
    renderToast();

    act(() => {
      emitPackageProgress({ ...progress, percent: 0, status: "error" });
    });

    expect(descriptionOf(vi.mocked(toast.error).mock.calls[0])).toContain(
      "Failed to apply the room packages",
    );
  });

  it("stops listening after it unmounts", () => {
    const off = vi.spyOn(bridgeEvents, "off");
    const { unmount } = renderToast();
    try {
      act(() => {
        emitPackageProgress(progress);
      });
      expect(toast.loading).toHaveBeenCalledTimes(1);

      unmount();
      expect(off).toHaveBeenCalledWith("packageProgress", expect.any(Function));
      expect(off).toHaveBeenCalledWith("packageError", expect.any(Function));

      act(() => {
        emitPackageProgress({ ...progress, percent: 80 });
      });
      expect(toast.loading).toHaveBeenCalledTimes(1);
    } finally {
      off.mockRestore();
    }
  });
});
