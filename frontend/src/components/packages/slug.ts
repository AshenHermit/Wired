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
  | "retired"
  | "error";

export const SLUG_HINT: Partial<Record<SlugCheckState, string>> = {
  invalid: "Строчные латинские буквы, цифры и _, минимум одна буква",
  checking: "Проверяем slug…",
  available: "Slug свободен",
  taken: "Slug уже занят",
  retired: "Этот slug был удалён и не может быть использован снова",
  error: "Не удалось проверить slug. Попробуйте ещё раз",
};

export function isSlugValid(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(slug)
  );
}

export function slugHintClass(state: SlugCheckState): string {
  if (state === "taken" || state === "retired" || state === "error") {
    return "text-destructive";
  }
  return "text-muted-foreground";
}
