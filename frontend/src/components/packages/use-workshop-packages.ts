"use client";

import type { WorkshopPackageSummary } from "@wired-io/shared";
import * as React from "react";
import { listWorkshopPackages } from "@/api/services/scripting-packages";
import { toAppMessage } from "@/i18n/api-error";
import type { AppMessage } from "@/i18n/message";

const PAGE_SIZE = 50;
/** Mirrors the slug check in the package form: no request per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Lists the workshop catalogue for the browser and the in-room dialog. The
 * first page loads on mount and every query change restarts the debounce, so
 * only the last query reaches the backend.
 */
export function useWorkshopPackages() {
  const [query, setQuery] = React.useState("");
  const [items, setItems] = React.useState<WorkshopPackageSummary[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<AppMessage | null>(null);
  const requestRef = React.useRef(0);

  const load = React.useCallback(async (q: string, offset: number) => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const listing = await listWorkshopPackages({
        q,
        limit: PAGE_SIZE,
        offset,
      });
      if (request !== requestRef.current) return;
      setItems((previous) =>
        offset === 0 ? listing.items : [...previous, ...listing.items]
      );
      setTotal(listing.total);
    } catch (caught) {
      if (request !== requestRef.current) return;
      setError(toAppMessage(caught));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  const trimmedQuery = query.trim();

  React.useEffect(() => {
    // Drop the results of a request for the previous query right away, so a
    // slow response cannot overwrite what the user is searching for now.
    requestRef.current += 1;
    const timer = window.setTimeout(() => {
      void load(trimmedQuery, 0);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trimmedQuery, load]);

  const reload = React.useCallback(
    () => load(trimmedQuery, 0),
    [load, trimmedQuery]
  );

  const loadMore = React.useCallback(
    () => load(trimmedQuery, items.length),
    [load, trimmedQuery, items.length]
  );

  return {
    query,
    setQuery,
    items,
    total,
    loading,
    error,
    reload,
    loadMore,
    hasMore: items.length < total,
  };
}
