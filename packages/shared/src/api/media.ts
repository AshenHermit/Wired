export type MediaUploadResponse = {
  url: string;
};

/** Relative URL returned by POST /media and stored on room/package previewImage. */
export const WIRED_MEDIA_URL_PATTERN =
  /^\/media\/[0-9a-f]{64}\.(png|jpg|webp)$/;

export function isWiredMediaUrl(value: string): boolean {
  return WIRED_MEDIA_URL_PATTERN.test(value);
}
