export enum Methods {
  POST = "POST",
  GET = "GET",
  PUT = "PUT",
  PATCH = "PATCH",
  DELETE = "DELETE",
}

export type Query = Record<string, any>;
type Config = Partial<{
  cache: RequestInit["cache"];
  revalidate: NextFetchRequestConfig["revalidate"];
  tags: NextFetchRequestConfig["tags"];
}>;

export interface APIMethodsParams<T, K = Query> {
  path: string;
  method: Methods;
  params?: K;
  payload?: T;
  config?: Config;
}

export interface FetchError<T = Record<string, unknown>> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
}

export interface ErrorResponse<T = Record<string, unknown>> {
  response: FetchError<T>;
}
