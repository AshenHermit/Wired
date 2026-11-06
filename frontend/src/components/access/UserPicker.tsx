"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import type { PublicUser } from "@wired-io/shared";
import { searchUsers } from "@/api/services/users";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Controlled user picker for access lists.
 *
 * The parent owns the selection as a list of user ids (`selectedUserIds`) and
 * receives an updated list through `onChange` whenever a user is added or
 * removed. Display names are resolved from two sources, merged into an internal
 * `knownUsers` cache:
 *
 * 1. Search results — every user returned by `searchUsers` is cached, so a chip
 *    keeps its name after the query is cleared.
 * 2. `selectedUsers` — an optional prop the parent passes for ids that are
 *    already selected before this picker has ever searched for them. There is
 *    no batch fetch-by-id endpoint on the API, so pre-selected names must come
 *    from the parent. If a selected id is not resolved either way, the chip
 *    falls back to the numeric id.
 *
 * Search is debounced ({@link SEARCH_DEBOUNCE_MS} ms): results are requested
 * only after the user stops typing, and an empty or whitespace-only query never
 * issues a request.
 */
export function UserPicker({
  selectedUserIds,
  onChange,
  disabled = false,
  selectedUsers,
  className,
}: {
  selectedUserIds: number[];
  onChange: (userIds: number[]) => void;
  disabled?: boolean;
  /** Pre-resolved users for ids that are already selected. */
  selectedUsers?: PublicUser[];
  className?: string;
}) {
  const t = useTranslations("UserPicker");
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PublicUser[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [knownUsers, setKnownUsers] = React.useState<
    Map<number, PublicUser>
  >(() => new Map());

  // Seed the name cache with any pre-selected users the parent already knows.
  React.useEffect(() => {
    if (!selectedUsers?.length) return;
    setKnownUsers((prev) => {
      const next = new Map(prev);
      for (const user of selectedUsers) next.set(user.id, user);
      return next;
    });
  }, [selectedUsers]);

  // Debounced search. An empty/whitespace query produces no results and no
  // network request.
  React.useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      searchUsers(q)
        .then((users) => {
          if (cancelled) return;
          setResults(users);
          setKnownUsers((prev) => {
            const next = new Map(prev);
            for (const user of users) next.set(user.id, user);
            return next;
          });
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const visibleResults = React.useMemo(
    () => results.filter((user) => !selectedUserIds.includes(user.id)),
    [results, selectedUserIds],
  );

  function addUser(user: PublicUser) {
    if (selectedUserIds.includes(user.id)) return;
    setKnownUsers((prev) => new Map(prev).set(user.id, user));
    onChange([...selectedUserIds, user.id]);
  }

  function removeUser(id: number) {
    onChange(selectedUserIds.filter((selectedId) => selectedId !== id));
  }

  function labelFor(id: number) {
    return knownUsers.get(id)?.name ?? String(id);
  }

  return (
    <div className={cn("space-y-2", className)}>
      {selectedUserIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {selectedUserIds.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {labelFor(id)}
              <button
                type="button"
                aria-label={t("remove", { name: labelFor(id) })}
                disabled={disabled}
                onClick={() => removeUser(id)}
                className="rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <Input
        type="text"
        value={query}
        disabled={disabled}
        placeholder={t("placeholder")}
        aria-label={t("searchLabel")}
        autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
      />

      {query.trim() !== "" && !disabled && (
        <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
          {loading && (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("loading")}
            </li>
          )}
          {!loading &&
            visibleResults.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  onClick={() => addUser(user)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  {user.picture ? (
                    <img
                      src={user.picture}
                      alt=""
                      className="size-5 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium uppercase text-muted-foreground">
                      {user.name.charAt(0)}
                    </span>
                  )}
                  <span className="truncate">{user.name}</span>
                </button>
              </li>
            ))}
          {!loading && visibleResults.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("noResults")}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
