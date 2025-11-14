import HTTPClient from "@/api/HTTPClient";

import type { APIMethodsParams, Query } from "./types";
import { API_URL, REVALIDATE_INTERVAL } from "@/utils/variables";

export class RequestManagerBase {
  protected api: Record<string, HTTPClient> = {};

  constructor() {
    this.api.client = new HTTPClient({
      baseURL: API_URL,
      cache: "no-store", // Отключаем кэширование для клиентских запросов
    });
    this.api.server = new HTTPClient({
      baseURL: API_URL,
      // Do not forward cookies from the incoming request to the backend when caching on the server,
      // otherwise the cache key explodes per-session and fills fetch-cache.
      credentials: "omit",
      // Be explicit about caching on the server; revalidate controls TTL.
      cache: "force-cache",
      next: {
        revalidate: REVALIDATE_INTERVAL,
        tags: ["api-data"], // Добавляем теги для группировки
      },
    });
  }

  async makeServerRequest<T, K extends Query = Query, R = null>(
    params: APIMethodsParams<R, K>
  ): Promise<T> {
    return await this.api.server.request(params);
  }

  async makeClientRequest<T, K extends Query = Query, R = null>(
    params: APIMethodsParams<R, K>
  ): Promise<T> {
    return await this.api.client.request(params);
  }

  getClientApi() {
    return this.api.client;
  }
}
