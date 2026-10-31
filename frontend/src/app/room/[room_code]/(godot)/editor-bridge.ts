/**
 * Bridge registered by the Wired editor plugin inside the running Godot web
 * editor. The plugin answers only through this explicit request/response pair:
 * the frontend never gets a generic JavaScript eval channel into the engine.
 * `request` takes a positive request id, an operation name and a JSON object
 * payload, and answers through `window.__wiredEditorBridgeResult`.
 */
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

export type EditorBridgeClient = {
  call<T>(op: string, params?: Record<string, unknown>): Promise<T>;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const BRIDGE_POLL_MS = 250;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingRequests = new Map<number, PendingRequest>();
let nextRequestId = 1;
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
    new EditorBridgeError(
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
 * `collect`, `replace`, ...). Every call is matched to its answer by id; the
 * timeout is shared by all calls of this client.
 */
export function createEditorBridgeClient(options: {
  timeoutMs?: number;
} = {}): EditorBridgeClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    call<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      return new Promise<T>((resolve, reject) => {
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
  };
}

/**
 * Waits until the editor plugin registers its `request` callback. The plugin
 * appears only after the editor finishes loading, which can lag behind the
 * shell by seconds.
 */
export function waitForEditorBridge(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const poll = (elapsed: number) => {
      if (hasBridgeRequest()) {
        resolve();
        return;
      }
      if (elapsed >= timeoutMs) {
        reject(
          new EditorBridgeError(
            `Мост редактора не появился за ${timeoutMs} мс`,
          ),
        );
        return;
      }
      const delay = Math.min(BRIDGE_POLL_MS, timeoutMs - elapsed);
      setTimeout(() => poll(elapsed + delay), delay);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
