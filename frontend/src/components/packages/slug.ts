import {
  PACKAGE_SLUG_MAX_LENGTH,
  PACKAGE_SLUG_PATTERN,
  isValidPackageSlug,
} from "@wired-io/shared";
import type { MessageKey } from "@/i18n/message";

/**
 * The slug rule itself lives in `@wired-io/shared` so the server DTOs and the
 * editor dialogs cannot drift apart. Re-exported here because every editor
 * consumer imports its slug helpers from this module.
 */
export {
  PACKAGE_SLUG_MAX_LENGTH,
  PACKAGE_SLUG_PATTERN,
  isValidPackageSlug,
};

/** How long the creation form waits before asking the backend about a slug. */
export const SLUG_CHECK_DEBOUNCE_MS = 300;

export type SlugCheckState =
  | "idle"
  | "invalid"
  | "checking"
  | "available"
  | "taken"
  | "error";

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

export function slugHintClass(state: SlugCheckState): string {
  if (state === "taken" || state === "error") {
    return "text-destructive";
  }
  return "text-muted-foreground";
}
