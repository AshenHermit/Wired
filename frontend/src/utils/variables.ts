export const BACKEND_URL = String(
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "NO BACKEND URL IN .ENV"
);

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

export const GODOT_EDITOR_URL = `/api/godot-editor`;
