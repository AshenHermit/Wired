import { withApiPrefix } from "@/utils/variables";

/** Browser URL for a backend `/media/...` path under COEP pages. */
export function mediaSrc(url: string): string {
  return withApiPrefix(url);
}
