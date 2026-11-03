import { isAxiosError } from "axios";
import type { AppMessage } from "./message";

export function toAppMessage(error: unknown): AppMessage {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  if (status === 401) return { key: "Errors.unauthorized" };
  if (status === 403) return { key: "Errors.forbidden" };
  if (status === 404) return { key: "Errors.notFound" };
  if (status === 409) return { key: "Errors.conflict" };
  if (status !== undefined && status >= 500) return { key: "Errors.server" };
  console.error(error);
  return { key: "Errors.unexpected" };
}
