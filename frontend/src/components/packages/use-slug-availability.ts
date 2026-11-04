"use client";

import * as React from "react";
import type { PackageSlugAvailability } from "@wired-io/shared";
import {
  SLUG_CHECK_DEBOUNCE_MS,
  isValidPackageSlug,
  type SlugCheckState,
} from "./slug";

/** Verdict the caller derives from one successful availability response. */
export type SlugAvailabilityVerdict = "available" | "taken";

export type UseSlugAvailability = {
  /** Current raw input value; trimmed internally. */
  slug: string;
  /** Whether the check may run at all (dialog open, form mounted). */
  enabled: boolean;
  /**
   * Value that is free by definition, so it never needs a round-trip — the
   * package's own slug while renaming.
   */
  unchanged?: string;
  /** Performs the request for the trimmed slug. */
  check: (slug: string) => Promise<PackageSlugAvailability>;
  /** Projects the response onto available/taken. */
  verdict: (result: PackageSlugAvailability) => SlugAvailabilityVerdict;
};

export type SlugAvailability = {
  state: SlugCheckState;
  /** Last successful response for the current slug, or `null`. */
  result: PackageSlugAvailability | null;
  /** Re-runs the check after a transport error. */
  retry: () => void;
};

/**
 * Owns the debounced slug-availability probe shared by the create, rename and
 * fork dialogs: it trims the input, applies the local rule, ignores responses
 * for a slug that already changed and exposes `retry` for the error hint.
 *
 * The state is derived from the current input on every render, so a submit can
 * never read a stale `available` while a debounce is still pending.
 */
export function useSlugAvailability({
  slug,
  enabled,
  unchanged,
  check,
  verdict,
}: UseSlugAvailability): SlugAvailability {
  const trimmed = slug.trim();
  const base: SlugCheckState = !enabled
    ? "idle"
    : trimmed.length === 0
      ? "idle"
      : trimmed === unchanged
        ? "available"
        : isValidPackageSlug(trimmed)
          ? "checking"
          : "invalid";

  const [settled, setSettled] = React.useState<{
    slug: string;
    state: "available" | "taken" | "error";
    result: PackageSlugAvailability | null;
  } | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  // Callers pass inline closures; keeping them in refs lets the effect depend
  // on the input only instead of restarting the debounce on every render.
  const checkRef = React.useRef(check);
  const verdictRef = React.useRef(verdict);
  React.useEffect(() => {
    checkRef.current = check;
    verdictRef.current = verdict;
  });

  React.useEffect(() => {
    if (base !== "checking") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void checkRef
        .current(trimmed)
        .then((result) => {
          if (cancelled) return;
          setSettled({ slug: trimmed, state: verdictRef.current(result), result });
        })
        .catch(() => {
          if (cancelled) return;
          setSettled({ slug: trimmed, state: "error", result: null });
        });
    }, SLUG_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [attempt, base, trimmed]);

  React.useEffect(() => {
    if (enabled) return;
    setSettled(null);
    setAttempt(0);
  }, [enabled]);

  const current = settled?.slug === trimmed ? settled : null;
  const retry = React.useCallback(() => {
    setSettled(null);
    setAttempt((value) => value + 1);
  }, []);

  return {
    state: base === "checking" ? (current?.state ?? "checking") : base,
    result: current?.result ?? null,
    retry,
  };
}
