/**
 * Bridge registered by the Wired editor plugin inside the running Godot web
 * editor. It is intentionally limited to a filesystem rescan: the frontend
 * never gets a generic JavaScript eval channel into the engine.
 */
export type WiredEditorBridge = {
  rescan?: () => void;
};

declare global {
  interface Window {
    __wiredEditorBridge?: WiredEditorBridge;
  }
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
