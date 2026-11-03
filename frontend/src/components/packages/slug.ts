/** Mirrors the server: lowercase latin letters, digits or `_`, one letter. */
export const SLUG_PATTERN = /^(?=.*[a-z])[a-z0-9_]+$/;
export const SLUG_MAX_LENGTH = 64;
/** How long the creation form waits before asking the backend about a slug. */
export const SLUG_CHECK_DEBOUNCE_MS = 300;

export type SlugCheckState =
  | "idle"
  | "invalid"
  | "checking"
  | "available"
  | "taken"
  | "error";

import type { MessageKey } from "@/i18n/message";

export const SLUG_HINT_KEYS: Partial<Record<SlugCheckState, MessageKey>> = {
  invalid: "Slug.invalid",
  checking: "Slug.checking",
  available: "Slug.available",
  taken: "Slug.taken",
  error: "Slug.checkFailed",
};

export function slugHintKey(state: SlugCheckState): MessageKey | undefined {
  return SLUG_HINT_KEYS[state];
}

export function isSlugValid(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(slug)
  );
}

export function slugHintClass(state: SlugCheckState): string {
  if (state === "taken" || state === "error") {
    return "text-destructive";
  }
  return "text-muted-foreground";
}
