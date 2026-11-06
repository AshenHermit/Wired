import type { MediaUploadResponse } from "@wired-io/shared";
import { apiClient } from "../api-client/api-client";

export function uploadMedia(file: File): Promise<MediaUploadResponse> {
  return apiClient.postFile<MediaUploadResponse>("media", file);
}
