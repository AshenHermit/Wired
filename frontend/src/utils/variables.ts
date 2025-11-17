export const API_URL = String(
  process.env.NEXT_PUBLIC_API_URL ?? "NO API URL IN .ENV"
);
export const REVALIDATE_INTERVAL =
  Number(process.env.REVALIDATE_INTERVAL) || 180;
