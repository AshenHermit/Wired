import HTTPClient from "@/api/HTTPClient"
import { cookies, headers } from "next/headers"

import type { APIMethodsParams, Query } from "./types"
import { API_URL, NEXT_URL, REVALIDATE_INTERVAL } from "@/utils/variables"
import { RequestManagerBase } from "./RequestManagerBase"

class RequestManager extends RequestManagerBase {
  constructor() {
    super()
    this.api.client = new HTTPClient({
      baseURL: API_URL,
      cache: "no-store", // Отключаем кэширование
      next: {
        revalidate: 0, // Отключаем revalidation
        tags: ["server-api"],
      },
    })
  }
}

const requestManager = new RequestManager()

export default requestManager
