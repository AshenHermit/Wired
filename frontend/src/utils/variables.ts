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
