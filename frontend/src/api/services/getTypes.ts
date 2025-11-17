import requestManager from "@/api/ClientRequestManager";
import { Methods, Query } from "@/api/types";
import { TypeFile } from "./types";

export async function getWiredIoTypes() {
  const data = await requestManager.makeClientRequest<TypeFile[], Query, null>({
    method: Methods.GET,
    path: "types/wired-io",
  });

  return data;
}

export async function getLibsTypes() {
  const data = await requestManager.makeClientRequest<TypeFile[], Query, null>({
    method: Methods.GET,
    path: "types/libs",
  });

  return data;
}
