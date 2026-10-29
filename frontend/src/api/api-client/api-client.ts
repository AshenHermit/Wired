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

export class ApiClient {
  axios: AxiosInstance;

  constructor(axiosClient: AxiosInstance) {
    this.axios = axiosClient;
  }

  async processResponse<T>(res: Promise<AxiosResponse<any, any>>) {
    try {
      const response = await res;
      return response.data as T;
    } catch (error) {
      throw new APIError(extractMessage(error));
    }
  }

  async get<T, R>(endpoint: string, data?: R) {
    return this.processResponse<T>(this.axios.get(endpoint, { params: data }));
  }
  async getFile<R>(endpoint: string, data?: R) {
    return this.processResponse<ArrayBuffer>(
      this.axios.get(endpoint, { params: data, responseType: "arraybuffer" })
    );
  }
  async post<T, R>(endpoint: string, data?: R) {
    return this.processResponse<T>(this.axios.post(endpoint, data));
  }
  async patch<T, R>(endpoint: string, data?: R) {
    return this.processResponse<T>(this.axios.patch(endpoint, data));
  }
  async delete<T, R>(endpoint: string, data?: R) {
    return this.processResponse<T>(
      this.axios.delete(endpoint, { params: data })
    );
  }

  async postFile<T>(endpoint: string, file: File) {
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
