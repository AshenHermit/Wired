import HTTPClient from "@/api/HTTPClient";
import { RequestManagerBase } from "./RequestManagerBase";

export class RequestManager extends RequestManagerBase {
  constructor() {
    super();
    this.api.nextServer = new HTTPClient({
      baseURL: "/api/",
      cache: "no-store",
    });
  }
}

const requestManager = new RequestManager();
export default requestManager;
