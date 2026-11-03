import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";

export class APIError extends AxiosError {}

function extractMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const payload = error.response?.data as { message?: unknown } | undefined;
    const message = payload?.message;
    if (Array.isArray(message)) {
      return message.map(String).join("; ");
    }
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Request failed";
}

/** Query string values accepted by the client, forwarded to axios verbatim. */
export type ApiClientQuery = Record<string, unknown>;

export class ApiClient {
  axios: AxiosInstance;

  constructor(axiosClient: AxiosInstance) {
    this.axios = axiosClient;
  }

  async processResponse<T>(res: Promise<AxiosResponse<T>>): Promise<T> {
    try {
      const response = await res;
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Keep the response: callers need the HTTP status and the structured
        // `code` (for example `packages_pending` is a wait, not a failure).
        throw new APIError(
          extractMessage(error),
          error.code,
          error.config,
          error.request,
          error.response,
        );
      }
      throw new APIError(
        error instanceof Error ? error.message : "Request failed",
      );
    }
  }

  async get<T>(endpoint: string, params?: ApiClientQuery): Promise<T> {
    return this.processResponse<T>(this.axios.get(endpoint, { params }));
  }
  async getFile(endpoint: string, params?: ApiClientQuery): Promise<ArrayBuffer> {
    return this.processResponse<ArrayBuffer>(
      this.axios.get(endpoint, { params, responseType: "arraybuffer" })
    );
  }
  async post<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.processResponse<T>(this.axios.post(endpoint, body));
  }
  async patch<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.processResponse<T>(this.axios.patch(endpoint, body));
  }
  async delete<T>(endpoint: string, params?: ApiClientQuery): Promise<T> {
    return this.processResponse<T>(
      this.axios.delete(endpoint, { params })
    );
  }

  async postFile<T>(endpoint: string, file: File): Promise<T> {
    const formData = new FormData();
    formData.append("file", file);
    return this.processResponse<T>(
      this.axios.post(endpoint, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      })
    );
  }
}
