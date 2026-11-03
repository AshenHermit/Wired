import { isAxiosError } from "axios";
import type { AppMessage } from "./message";

interface ApiErrorResponse {
  status?: number;
  data?: unknown;
}

/**
 * The transport-level response of a failed API call. Every reader of a
 * backend error body goes through here, so the axios boundary is described
 * once instead of being re-cast at each call site.
 */
export function apiErrorResponse(error: unknown): ApiErrorResponse | null {
  const response = (error as { response?: unknown } | null | undefined)
    ?.response;
  return response !== null && typeof response === "object"
    ? (response as ApiErrorResponse)
    : null;
}

/** The response body of a failed API call, narrowed to the caller's shape. */
export function apiErrorBody<T extends object>(error: unknown): T | null {
  const data = apiErrorResponse(error)?.data;
  return data !== null && typeof data === "object" ? (data as T) : null;
}

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
