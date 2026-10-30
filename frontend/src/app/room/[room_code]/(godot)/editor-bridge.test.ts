import { afterEach, describe, expect, it, vi } from "vitest";
import { requestEditorRescan } from "./editor-bridge";

describe("requestEditorRescan", () => {
  afterEach(() => {
    delete (window as { __wiredEditorBridge?: unknown }).__wiredEditorBridge;
  });

  it("returns false when the editor bridge is not available", () => {
    expect(requestEditorRescan()).toBe(false);
  });

  it("calls the bridge callback when it is registered", () => {
    const rescan = vi.fn();
    Object.assign(window, { __wiredEditorBridge: { rescan } });

    expect(requestEditorRescan()).toBe(true);
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the bridge callback fails", () => {
    Object.assign(window, {
      __wiredEditorBridge: {
        rescan: () => {
          throw new Error("editor is gone");
        },
      },
    });

    expect(requestEditorRescan()).toBe(false);
  });
});
