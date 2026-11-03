"use client";

import type { WorkshopPackageSummary } from "@wired-io/shared";
import { Loader2Icon, SearchIcon, XIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkshopPackages } from "./use-workshop-packages";

type WorkshopBrowserProps = {
  /** Renders a per-package action button when given. */
  onSelect?: (workshopPackage: WorkshopPackageSummary) => void;
  selectLabel?: string;
  busyId?: number | null;
};

/**
 * Public workshop catalogue. It does not assume a page: the homepage renders it
 * directly and the room dialog renders it inside a dialog.
 */
export function WorkshopBrowser({
  onSelect,
  selectLabel,
  busyId,
}: WorkshopBrowserProps) {
  const {
    query,
    setQuery,
    items,
    loading,
    error,
    reload,
    loadMore,
    hasMore,
  } = useWorkshopPackages();
  const trimmedQuery = query.trim();

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Поиск пакетов"
          className="pr-9 pl-9"
          placeholder="Поиск по названию, slug или тегу"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <Button
            aria-label="Очистить поиск"
            className="absolute top-1/2 right-1 -translate-y-1/2"
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => setQuery("")}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive">
          <p>{error}</p>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void reload()}
          >
            Повторить
          </Button>
        </div>
      ) : loading && items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span>Загружаем пакеты…</span>
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-4 text-muted-foreground">
          {trimmedQuery
            ? `Ничего не найдено по запросу «${trimmedQuery}»`
            : "В workshop пока нет пакетов"}
        </p>
      ) : (
        <>
          <div className="grid gap-3">
            {items.map((item) => (
              <WorkshopPackageCard
                key={item.id}
                busy={busyId === item.id}
                item={item}
                selectLabel={selectLabel}
                onSelect={onSelect}
              />
            ))}
          </div>
          {hasMore ? (
            <Button
              className="self-start"
              disabled={loading}
              size="sm"
              type="button"
              variant="outline"
              onClick={() => void loadMore()}
            >
              {loading ? <Loader2Icon className="animate-spin" /> : null}
              Показать ещё
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function WorkshopPackageCard({
  item,
  onSelect,
  selectLabel,
  busy,
}: {
  item: WorkshopPackageSummary;
  onSelect?: (workshopPackage: WorkshopPackageSummary) => void;
  selectLabel?: string;
  busy: boolean;
}) {
  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-medium">{item.name}</h3>
            <code className="font-mono text-xs text-muted-foreground">
              #{item.slug}
            </code>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">{item.version}</span>
            {item.author ? <span>{item.author.name}</span> : null}
            <span>ревизия {item.revision}</span>
            <span>{new Date(item.publishedAt).toLocaleDateString("ru-RU")}</span>
          </div>
          {item.description ? (
            <p className="mt-2 line-clamp-2 text-muted-foreground">
              {item.description}
            </p>
          ) : null}
          {item.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {onSelect ? (
          <Button
            disabled={busy}
            size="sm"
            type="button"
            onClick={() => onSelect(item)}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : null}
            {selectLabel ?? "Добавить"}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
