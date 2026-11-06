"use client";

import * as React from "react";
import { listWorkshopTags } from "@/api/services/scripting-packages";
import type { AppMessage } from "@/i18n/message";
import { toAppMessage } from "@/i18n/api-error";
import { errorMessage } from "@/utils/errors";
import type { WorkshopTagCount } from "@wired-io/shared";

export const WORKSHOP_TAGS_CACHE_TTL_MS = 60_000;

let cache: { tags: WorkshopTagCount[]; expiresAt: number } | null = null;
let inFlight: Promise<WorkshopTagCount[]> | null = null;

function cacheIsFresh(): boolean {
  return cache !== null && cache.expiresAt > Date.now();
}

function loadWorkshopTags(): Promise<WorkshopTagCount[]> {
  if (cacheIsFresh()) return Promise.resolve(cache!.tags);
  if (inFlight) return inFlight;

  inFlight = listWorkshopTags({ limit: 200 })
    .then((listing) => {
      cache = {
        tags: listing.items,
        expiresAt: Date.now() + WORKSHOP_TAGS_CACHE_TTL_MS,
      };
      return listing.items;
    })
    .catch((caught: unknown) => {
      // A failed listing is not an empty workshop. Leave the cache cold so the
      // next mount retries, and keep the cause visible instead of turning a
      // transient outage into "no tags" for a minute.
      console.warn(`Workshop tags unavailable: ${errorMessage(caught)}`);
      throw caught;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Test helper: forget the module cache between test cases. */
export function resetWorkshopTagsCache(): void {
  cache = null;
  inFlight = null;
}

export function useWorkshopTags(): {
  tags: WorkshopTagCount[];
  loading: boolean;
  error: AppMessage | null;
} {
  const [tags, setTags] = React.useState<WorkshopTagCount[]>(
    cacheIsFresh() ? cache!.tags : [],
  );
  const [loading, setLoading] = React.useState(!cacheIsFresh());
  const [error, setError] = React.useState<AppMessage | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (cacheIsFresh()) {
      setTags(cache!.tags);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void loadWorkshopTags()
      .then((next) => {
        if (cancelled) return;
        setTags(next);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(toAppMessage(caught));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { tags, loading, error };
}
