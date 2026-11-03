"use client";

import * as React from "react";
import { listWorkshopTags } from "@/api/services/scripting-packages";
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
    .catch(() => {
      cache = {
        tags: [],
        expiresAt: Date.now() + WORKSHOP_TAGS_CACHE_TTL_MS,
      };
      return [];
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
} {
  const [tags, setTags] = React.useState<WorkshopTagCount[]>(
    cacheIsFresh() ? cache!.tags : [],
  );
  const [loading, setLoading] = React.useState(!cacheIsFresh());

  React.useEffect(() => {
    let cancelled = false;
    if (cacheIsFresh()) {
      setTags(cache!.tags);
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadWorkshopTags().then((next) => {
      if (cancelled) return;
      setTags(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { tags, loading };
}
