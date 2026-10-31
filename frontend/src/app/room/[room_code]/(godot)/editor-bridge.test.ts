import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEditorBridgeClient,
  EditorBridgeError,
  requestEditorRescan,
  waitForEditorBridge,
} from "./editor-bridge";

/** Answers a request the way the Godot plugin does: a plain JS object. */
function sendResult(message: unknown): void {
  const handler = window.__wiredEditorBridgeResult;
  if (typeof handler !== "function") {
    throw new Error("the result handler is not installed");
  }
  handler(message);
}

function installRequest(request: (requestId: number) => void) {
  const mock = vi.fn((requestId: number) => request(requestId));
  Object.assign(window, { __wiredEditorBridge: { request: mock } });
  return mock;
}

function lastRequestId(mock: { mock: { calls: unknown[][] } }): number {
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error("no bridge request was made");
  return call[0] as number;
}

afterEach(() => {
  vi.useRealTimers();
  delete (window as { __wiredEditorBridge?: unknown }).__wiredEditorBridge;
  delete (window as { __wiredEditorBridgeResult?: unknown })
    .__wiredEditorBridgeResult;
});

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

describe("EditorBridgeClient", () => {
  it("resolves the response matched by id", async () => {
    const request = installRequest((requestId) => {
      queueMicrotask(() => {
        sendResult({ id: requestId, ok: true, value: { files: {} } });
      });
    });
    const client = createEditorBridgeClient();

    await expect(client.call("snapshot", { packageId: 1 })).resolves.toEqual({
      files: {},
    });
    expect(request).toHaveBeenCalledWith(
      expect.any(Number),
      "snapshot",
      '{"packageId":1}',
    );
  });

  it("ignores a response with an unknown id", async () => {
    vi.useFakeTimers();
    const request = installRequest(() => {});
    const client = createEditorBridgeClient();

    const promise = client.call("snapshot", { packageId: 1 });
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    sendResult({ id: 999, ok: true, value: { files: {} } });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);

    sendResult({
      id: lastRequestId(request),
      ok: true,
      value: { files: { "main.gd": "abc" } },
    });
    await expect(promise).resolves.toEqual({
      files: { "main.gd": "abc" },
    });
  });

  it("ignores malformed responses without throwing", async () => {
    const request = installRequest(() => {});
    const client = createEditorBridgeClient({ timeoutMs: 1000 });

    const promise = client.call("sync");
    expect(() => {
      sendResult(null);
      sendResult(undefined);
      sendResult({});
      sendResult({ id: "not-a-number", ok: true });
    }).not.toThrow();

    sendResult({ id: lastRequestId(request), ok: true, value: {} });
    await expect(promise).resolves.toEqual({});
  });

  it("rejects with the GDScript error", async () => {
    installRequest((requestId) => {
      sendResult({ id: requestId, ok: false, error: "staging не найден" });
    });
    const client = createEditorBridgeClient();

    await expect(
      client.call("prepareReplace", { packageId: 1 }),
    ).rejects.toThrow("staging не найден");
  });

  it("times out", async () => {
    vi.useFakeTimers();
    installRequest(() => {});
    const client = createEditorBridgeClient({ timeoutMs: 50 });

    const promise = client.call("sync");
    const assertion = expect(promise).rejects.toThrow("не ответил за 50 мс");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("rejects when the bridge is gone", async () => {
    const client = createEditorBridgeClient();

    await expect(client.call("exists", { packageId: 1 })).rejects.toThrow(
      EditorBridgeError,
    );
    await expect(client.call("exists", { packageId: 1 })).rejects.toThrow(
      "Мост редактора недоступен",
    );
  });
});

describe("waitForEditorBridge", () => {
  it("waits for a late bridge", async () => {
    vi.useFakeTimers();
    const promise = waitForEditorBridge(1000);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBe(false);

    installRequest(() => {});
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects after the timeout", async () => {
    vi.useFakeTimers();
    const promise = waitForEditorBridge(500);
    const assertion = expect(promise).rejects.toThrow(
      "Мост редактора не появился за 500 мс",
    );

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});
