import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeEvents,
  emitPackageProgress,
  packagePercent,
  type PackageProgressEvent,
} from "./editorBridgeEvents";

const progress: PackageProgressEvent = {
  packageId: "7",
  name: "Heroes",
  percent: 50,
  status: "loading",
};

afterEach(() => {
  bridgeEvents.all.clear();
});

describe("packagePercent", () => {
  it("derives a whole percentage from byte counts", () => {
    expect(packagePercent(0, 200)).toBe(0);
    expect(packagePercent(50, 200)).toBe(25);
    expect(packagePercent(1, 3)).toBe(33);
    expect(packagePercent(200, 200)).toBe(100);
  });

  it("never leaves the 0-100 range", () => {
    expect(packagePercent(500, 200)).toBe(100);
    expect(packagePercent(-5, 200)).toBe(0);
    expect(packagePercent(10, 0)).toBe(0);
    expect(packagePercent(Number.NaN, 200)).toBe(0);
  });
});

describe("editor bridge events", () => {
  it("exposes the listener methods a consumer subscribes with", () => {
    expect(typeof bridgeEvents.on).toBe("function");
    expect(typeof bridgeEvents.off).toBe("function");
    expect(typeof bridgeEvents.emit).toBe("function");
  });

  it("forwards progress to packageProgress listeners", () => {
    const listener = vi.fn();
    bridgeEvents.on("packageProgress", listener);

    emitPackageProgress(progress);

    expect(listener).toHaveBeenCalledWith(progress);
  });

  it("routes failures to packageError listeners only", () => {
    const progressListener = vi.fn();
    const errorListener = vi.fn();
    bridgeEvents.on("packageProgress", progressListener);
    bridgeEvents.on("packageError", errorListener);

    const failure: PackageProgressEvent = {
      ...progress,
      percent: 25,
      status: "error",
      errorMessage: "Package hero: cannot stage main.gd: disk full",
    };
    emitPackageProgress(failure);

    expect(errorListener).toHaveBeenCalledWith(failure);
    expect(progressListener).not.toHaveBeenCalled();
  });
});
