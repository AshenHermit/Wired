import type { APIMethodsParams, FetchError, Query } from "@/api/types";
import { NotFoundError } from "./errors";

const DEFAULT_OPTIONS: Pick<InitProps, "headers" | "credentials" | "mode"> = {
  credentials: "include",
  headers: {
    "Content-Type": "application/json;charset=utf-8",
    accept: "application/json, text/javascript, */*; q=0.01",
    "x-requested-with": "XMLHttpRequest",
  },
  mode: "cors",
};

interface InitProps extends RequestInit {
  baseURL: string;
}

type RequestParamsProcessor = (
  httpcl: HTTPClient,
  requestParams: RequestInit
) => void;
type Processor = (httpcl: HTTPClient) => void;

class HTTPClient {
  private options: InitProps;
  /**
   * @description опциональная функция процессор для редактирования requestParams перед тем как они попадут в fetch
   */
  public rParamsProcessor?: RequestParamsProcessor;
  public prepareProcessor?: Processor;
  public phpsessid: string;

  constructor(
    options: InitProps,
    processors?: {
      rParamsProcessor?: RequestParamsProcessor;
      prepareProcessor?: Processor;
    }
  ) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
    if (processors) {
      this.prepareProcessor = processors.prepareProcessor;
      this.rParamsProcessor = processors.rParamsProcessor;
    }
    this.phpsessid = "";
  }

  async fetchResponse<T, K extends Query = Query, R = null>({
    method,
    path,
    params,
    payload,
    config = {},
  }: APIMethodsParams<R, K>): Promise<Response> {
    const {
      baseURL,
      cache: baseCachePolicy,
      next: { revalidate: baseRevalidatePolicy, tags: groupTags } = {},
      ...otherRequestProps
    } = this.options;

    const {
      cache: currentRequestCachePolicy,
      revalidate: currentRevalidatePolicy,
      tags: currentRequestTags,
    } = config;

    const cache = currentRequestCachePolicy ?? baseCachePolicy;

    const next: NextFetchRequestConfig = {
      revalidate: currentRevalidatePolicy ?? baseRevalidatePolicy,
      tags: currentRequestTags ?? groupTags,
    };

    let requestParams: RequestInit = {
      method,
      ...otherRequestProps,
      cache,
      next,
    };
    if (payload) {
      if (payload instanceof FormData) {
        requestParams.body = payload;
        requestParams.headers = { ...requestParams.headers };
        delete (requestParams as any).headers["Content-Type"];
      } else {
        requestParams.body = JSON.stringify(payload);
      }
    }

    if (this.rParamsProcessor) {
      this.rParamsProcessor(this, requestParams);
    }

    let url = null;
    if (baseURL.startsWith("/")) {
      url = new URL(baseURL + path, "https://host");
      if (global["window"] && window.location && window.location.host) {
        url = new URL(baseURL + path, window.location.origin);
      }
    } else url = new URL(path, baseURL);

    const paramsKeys = Object.keys(params || {});

    if (params && paramsKeys.length && url) {
      paramsKeys.forEach((paramsKey) => {
        url.searchParams.set(paramsKey, params[paramsKey]);
      });
    }
    let urlStr = url.toString();
    urlStr = urlStr.replace("https://host", "");
    const response = await fetch(urlStr, requestParams);
    return response;
  }

  async throwNetworkError(response: Response) {
    const errorResponse: FetchError = {
      data: {},
      headers: {},
      status: 400,
      statusText: "Network error",
      url: "",
    };

    const headers = Array.from(response.headers.entries()).reduce(
      (acc, [key, value]) => (acc = { ...acc, [key]: value }),
      {}
    );

    errorResponse.status = response.status;
    errorResponse.statusText = response.statusText;
    errorResponse.url = response.url;
    errorResponse.headers = headers;

    const contentType = response.headers.get("Content-Type");

    if (contentType?.includes("application/json")) {
      const errorJson = await response.json();

      errorResponse.data = errorJson;
    }

    const stackTrace = new Error(
      `URL => ${response.url}\nStatusCode => ${response.status}\nStatusText => ${response.statusText}`
    );

    throw errorResponse;
  }

  checkDataForErrors(data: any, errorCallback: (error: Error) => void) {
    let error = null;
    if (typeof data === "object") {
      if ("statusCode" in data) {
        error = new Error(data.message, data.statusCode);
      } else if ("error" in data) {
        if (data.error == "not found") {
          error = new NotFoundError(data.result);
        } else if (data.error) {
          error = new Error(data.error, data.result);
        }
      }
      if (error) {
        errorCallback(error);
      }
    }
  }

  async request<T, K extends Query = Query, R = null>({
    method,
    path,
    params,
    payload,
    config = {},
  }: APIMethodsParams<R, K>): Promise<T> {
    if (this.prepareProcessor) {
      this.prepareProcessor(this);
    }
    try {
      const response = await this.fetchResponse({
        method,
        path,
        params,
        payload,
        config,
      });
      if (response.status > 500) {
        await this.throwNetworkError(response);
      }
      const jsonText = await response.text();
      let data;
      // проверяем ошибку формата json,
      // скорее всего это может быть редкая непредвиденная ошибка которую может веруть сервер в ответе
      try {
        data = JSON.parse(jsonText);
      } catch (e) {}

      this.checkDataForErrors(data, (error) => {
        throw error;
      });
      let result;
      if (typeof data === "object") {
        if (data.phpsessid && data.phpsessid != "deleted") {
          this.phpsessid = data.phpsessid;
        }
        if (data.authCookie) {
        }
        if ("result" in data) {
          result = data.result;
        } else {
          result = data;
        }
      } else {
        result = data;
      }

      return result as T;
    } catch (error) {
      if (error instanceof Error) {
        return Promise.reject(error);
      }

      const { data, headers, status, statusText, url } = (error ||
        {}) as FetchError;

      return Promise.reject({
        response: {
          data,
          headers,
          status,
          statusText,
          url,
        },
      });
    }
  }
}

export default HTTPClient;
