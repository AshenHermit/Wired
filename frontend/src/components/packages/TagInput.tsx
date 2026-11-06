"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/animate-ui/components/radix/popover";
import { cn } from "@/lib/utils";
import { useWorkshopTags } from "./use-workshop-tags";

export const TAG_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const MAX_TAGS = 10;

type Suggestion = {
  tag: string;
  count: number | null;
};

export function TagInput({
  id,
  value,
  onChange,
  disabled = false,
  max = MAX_TAGS,
  placeholder,
  onInvalidChange,
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  max?: number;
  placeholder?: string;
  onInvalidChange?: (invalid: boolean) => void;
}) {
  const t = useTranslations("Tags");
  const { tags: workshopTags, loading } = useWorkshopTags();
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<"format" | "limit" | null>(null);
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [navigated, setNavigated] = React.useState(false);
  const listId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const normalizedDraft = draft.trim().toLowerCase();

  const options = React.useMemo<Suggestion[]>(() => {
    const matches = workshopTags
      .filter(
        (item) =>
          !value.includes(item.tag) &&
          (normalizedDraft === "" || item.tag.includes(normalizedDraft)),
      )
      .slice(0, 8)
      .map((item) => ({ tag: item.tag, count: item.count }));

    const canCreate =
      normalizedDraft !== "" &&
      TAG_PATTERN.test(normalizedDraft) &&
      !value.includes(normalizedDraft) &&
      !matches.some((item) => item.tag === normalizedDraft);

    return canCreate
      ? [...matches, { tag: normalizedDraft, count: null }]
      : matches;
  }, [normalizedDraft, value, workshopTags]);

  React.useEffect(() => {
    setActiveIndex(0);
    setNavigated(false);
  }, [draft, value, open]);

  const showList = open && !disabled && (loading || options.length > 0);

  function updateError(next: "format" | "limit" | null) {
    setError(next);
    onInvalidChange?.(next !== null);
  }

  function commit(raw: string) {
    const tag = raw.trim().toLowerCase();
    if (!tag) {
      setDraft("");
      return;
    }
    if (!TAG_PATTERN.test(tag)) {
      updateError("format");
      return;
    }
    if (value.includes(tag)) {
      setDraft("");
      updateError(null);
      return;
    }
    if (value.length >= max) {
      updateError("limit");
      return;
    }
    onChange([...value, tag]);
    setDraft("");
    updateError(null);
  }

  function select(tag: string) {
    if (value.length >= max) {
      updateError("limit");
      return;
    }
    if (value.includes(tag)) {
      setDraft("");
      updateError(null);
      return;
    }
    onChange([...value, tag]);
    setDraft("");
    updateError(null);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "," || event.key === " ") {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = showList && navigated ? options[activeIndex] : undefined;
      if (option) select(option.tag);
      else commit(draft);
      return;
    }
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setNavigated(true);
      setActiveIndex((index) => (index + 1) % options.length);
      return;
    }
    if (event.key === "ArrowUp" && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setNavigated(true);
      setActiveIndex(
        (index) => (index - 1 + options.length) % options.length,
      );
    }
  }

  const activeOptionId =
    showList && options[activeIndex]
      ? `${listId}-option-${activeIndex}`
      : undefined;

  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          error &&
            "border-destructive focus-within:border-destructive focus-within:ring-destructive/20",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >
            {tag}
            <button
              type="button"
              aria-label={t("remove", { tag })}
              disabled={disabled}
              onClick={() => onChange(value.filter((item) => item !== tag))}
              className="rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed"
            >
              ×
            </button>
          </span>
        ))}
        <Popover open={showList} onOpenChange={setOpen}>
          <PopoverAnchor asChild>
            <input
              ref={inputRef}
              id={id}
              value={draft}
              disabled={disabled}
              placeholder={value.length === 0 ? (placeholder ?? t("placeholder")) : undefined}
              autoComplete="off"
              role="combobox"
              aria-expanded={showList}
              aria-controls={showList ? listId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={activeOptionId}
              className="min-w-24 flex-1 bg-transparent outline-none disabled:cursor-not-allowed"
              onChange={(event) => {
                const next = event.target.value;
                setDraft(next);
                setOpen(true);
                const tag = next.trim().toLowerCase();
                if (!tag) {
                  updateError(null);
                } else if (!TAG_PATTERN.test(tag)) {
                  updateError("format");
                } else if (value.length >= max) {
                  updateError("limit");
                } else {
                  updateError(null);
                }
              }}
              onFocus={() => setOpen(true)}
              onBlur={(event) => {
                const next = event.relatedTarget;
                if (
                  next instanceof Element &&
                  next.closest('[data-slot="popover-content"]')
                ) {
                  return;
                }
                setOpen(false);
                if (draft.trim() !== "") commit(draft);
              }}
              onKeyDown={handleKeyDown}
            />
          </PopoverAnchor>
          <PopoverContent
            align="start"
            sideOffset={4}
            className="w-(--radix-popover-anchor-width) p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            {loading && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {t("loading")}
              </p>
            )}
            <div
              role="listbox"
              id={listId}
              className="max-h-64 overflow-y-auto"
            >
              {options.map((option, index) => (
                <button
                  key={`${option.tag}-${index}`}
                  id={`${listId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(option.tag)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                    index === activeIndex && "bg-accent text-accent-foreground",
                  )}
                >
                  <span>
                    {option.count === null
                      ? t("create", { tag: option.tag })
                      : option.tag}
                  </span>
                  {option.count !== null && (
                    <span className="text-xs text-muted-foreground">
                      {t("count", { count: option.count })}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {error === "format" && (
        <p className="text-xs text-destructive">{t("formatHint")}</p>
      )}
      {error === "limit" && (
        <p className="text-xs text-destructive">
          {t("limit", { max })}
        </p>
      )}
    </div>
  );
}
