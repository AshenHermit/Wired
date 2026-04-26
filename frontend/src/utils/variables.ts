export const API_URL = String(
  process.env.NEXT_PUBLIC_API_URL ?? "NO API URL IN .ENV"
);
export const BACKEND_URL = String(
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "NO BACKEND URL IN .ENV"
);
export const WEBSOCKET_URL = String(
  process.env.NEXT_PUBLIC_WEBSOCKET_URL ?? "NO WEBSOCKET URL IN .ENV"
);
export const REVALIDATE_INTERVAL =
  Number(process.env.REVALIDATE_INTERVAL) || 180;

export const HASH_ID_SECRET = String(
  process.env.NEXT_PUBLIC_WEBSOCKET_URL ?? "wired-io-ids"
);

export const GODOT_EDITOR_URL = `/api/godot-editor`;
export const GODOT_PROJECT_ZIP_URL = `/api/godot-project.zip`;
