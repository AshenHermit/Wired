export const BACKEND_URL = String(
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "NO BACKEND URL IN .ENV"
);

/**
 * Prefix of the Next.js rewrite that proxies `/api/*` to the backend.
 *
 * Browser-facing URLs that must stay on the frontend origin (the WASM editor
 * assets, project files, the game export, the API root handed to the exported
 * Godot build) go through it. Axios is the exception: `api-client.ts` talks to
 * `BACKEND_URL` directly, because API calls are made from the browser to the
 * backend itself and only need the prefix when they are relative to the page.
 */
export const API_PREFIX = "/api";

/**
 * Adds the proxy prefix to a backend-provided absolute path. The backend
 * returns paths as it serves them (`/godot-project/wired/`), while the browser
 * must fetch them through the Next rewrite.
 */
export function withApiPrefix(path: string): string {
  return `${API_PREFIX}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Salt for room/package/user hashids. Changing it invalidates every existing
 * `/room/<code>` link, so it must stay stable after the first deploy. The
 * fallback keeps links created before the dedicated variable was introduced.
 */
export const HASH_ID_SECRET = String(
  process.env.NEXT_PUBLIC_HASHIDS_SALT ??
    process.env.NEXT_PUBLIC_WEBSOCKET_URL ??
    "wired-io-ids"
);

export const GODOT_EDITOR_URL = `${API_PREFIX}/godot-editor`;
