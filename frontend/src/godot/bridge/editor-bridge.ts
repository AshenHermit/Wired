/**
 * Bridge registered by the Wired editor plugin inside the running Godot web
 * editor. The plugin answers only through this explicit request/response pair:
 * the frontend never gets a generic JavaScript eval channel into the engine.
 * `request` takes a positive request id, an operation name and a JSON object
 * payload, and answers through `window.__wiredEditorBridgeResult`.
 */
import { errorMessage } from "@/utils/errors";

export type WiredEditorBridge = {
  rescan?: () => void;
  request?: (requestId: number, op: string, paramsJson: string) => void;
};

/** Shape the plugin evaluates into `window.__wiredEditorBridgeResult`. */
type EditorBridgeResultMessage = {
  id?: unknown;
  ok?: unknown;
  value?: unknown;
  error?: unknown;
};

declare global {
  interface Window {
    __wiredEditorBridge?: WiredEditorBridge;
    __wiredEditorBridgeResult?: (message: unknown) => void;
  }
}

/** A transport failure: the bridge is missing, silent or failed to respond. */
export class EditorBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorBridgeError";
  }
}

/**
 * An operation failed inside the editor: the bridge is alive and answered with
 * `{ok: false, error}`. Recoverable per operation, never a reason to reconnect.
 */
export class EditorBridgeOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorBridgeOperationError";
  }
}

/**
 * A request was abandoned because its client was disposed: the editor that
 * issued it is gone, so the answer no longer means anything. Not an editor
 * failure — callers must not report it or start a reconnect loop.
 */
export class EditorBridgeDisposedError extends Error {
  constructor() {
    super("Мост редактора закрыт: запрос отменён");
    this.name = "EditorBridgeDisposedError";
  }
}

export type EditorBridgeClient = {
  call<T>(op: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * Abandons every request this client is still waiting for.
   *
   * The page restarts the engine in place, and the plugin answers by request id
   * alone: a request left over from the previous editor would otherwise resolve
   * against the replacement's file system or sit until its timeout. Idempotent.
   */
  dispose(): void;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const BRIDGE_POLL_MS = 250;

type PendingRequest = {
  /** The client waiting for this answer; ids stay unique across all clients. */
  clientId: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingRequests = new Map<number, PendingRequest>();
let nextRequestId = 1;
let nextClientId = 1;
let installedResultHandler: ((message: unknown) => void) | null = null;

function handleBridgeResult(message: unknown): void {
  const result = (message ?? {}) as EditorBridgeResultMessage;
  const id = Number(result.id);
  if (!Number.isInteger(id) || id <= 0) return;
  const pending = pendingRequests.get(id);
  if (!pending) return;

  pendingRequests.delete(id);
  clearTimeout(pending.timer);
  if (result.ok === true) {
    pending.resolve(result.value);
    return;
  }
  pending.reject(
    new EditorBridgeOperationError(
      typeof result.error === "string" && result.error.length > 0
        ? result.error
        : "Мост редактора вернул ошибку без описания",
    ),
  );
}

/** Installs the plugin's answer callback once per module. */
function ensureResultHandler(): void {
  if (typeof window === "undefined") return;
  if (
    installedResultHandler !== null &&
    window.__wiredEditorBridgeResult === installedResultHandler
  ) {
    return;
  }
  installedResultHandler = handleBridgeResult;
  window.__wiredEditorBridgeResult = installedResultHandler;
}

function hasBridgeRequest(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.__wiredEditorBridge?.request === "function";
}

/**
 * Creates a client for the editor plugin operations (`exists`, `snapshot`,
 * `collect`, `replace`, ...). Every call is matched to its answer by id and has
 * its own timeout; a slow call never shortens the deadline of another one.
 */
export function createEditorBridgeClient(options: {
  timeoutMs?: number;
} = {}): EditorBridgeClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientId = nextClientId++;
  let disposed = false;

  return {
    call<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (disposed) {
          reject(new EditorBridgeDisposedError());
          return;
        }

        const request =
          typeof window === "undefined"
            ? undefined
            : window.__wiredEditorBridge?.request;
        if (typeof request !== "function") {
          reject(
            new EditorBridgeError(
              "Мост редактора недоступен: перезагрузите страницу",
            ),
          );
          return;
        }

        ensureResultHandler();
        const requestId = nextRequestId++;
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(
            new EditorBridgeError(
              `Мост редактора не ответил за ${timeoutMs} мс`,
            ),
          );
        }, timeoutMs);
        pendingRequests.set(requestId, {
          clientId,
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });

        try {
          request(requestId, op, JSON.stringify(params));
        } catch (error) {
          clearTimeout(timer);
          pendingRequests.delete(requestId);
          reject(new EditorBridgeError(errorMessage(error)));
        }
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [requestId, pending] of pendingRequests) {
        if (pending.clientId !== clientId) continue;
        pendingRequests.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(new EditorBridgeDisposedError());
      }
    },
  };
}

/**
 * The wait was cancelled by its owner (a component unmounted, the editor was
 * replaced). Not an editor failure: callers must not report it to the user or
 * start a reconnect loop.
 */
export class EditorBridgeWaitCancelledError extends Error {
  constructor() {
    super("Ожидание моста редактора отменено");
    this.name = "EditorBridgeWaitCancelledError";
  }
}

/**
 * Waits until the editor plugin registers its `request` callback. The plugin
 * appears only after the editor finishes loading, which can lag behind the
 * shell by seconds.
 *
 * The wait owns at most one timer at a time and clears it on abort, so an
 * unmount never leaves a 120 s polling chain running against a dead editor.
 */
export function waitForEditorBridge(
  timeoutMs: number,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = options;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EditorBridgeWaitCancelledError());
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
    };
    const onAbort = (): void => {
      settle();
      reject(new EditorBridgeWaitCancelledError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    const poll = (elapsed: number) => {
      if (settled) return;
      if (hasBridgeRequest()) {
        settle();
        resolve();
        return;
      }
      if (elapsed >= timeoutMs) {
        settle();
        reject(
          new EditorBridgeError(
            `Мост редактора не появился за ${timeoutMs} мс`,
          ),
        );
        return;
      }
      const delay = Math.min(BRIDGE_POLL_MS, timeoutMs - elapsed);
      timer = setTimeout(() => poll(elapsed + delay), delay);
    };
    poll(0);
  });
}

/** Asks the running editor to notice files written directly into its FS. */
export function requestEditorRescan(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const rescan = window.__wiredEditorBridge?.rescan;
  if (typeof rescan !== "function") {
    return false;
  }
  try {
    rescan();
    return true;
  } catch {
    return false;
  }
}

