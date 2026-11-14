"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { slugHintClass, slugHintKey } from "./slug";
import type { SlugAvailability } from "./use-slug-availability";

/**
 * Slug input shared by the create, rename and fork dialogs. It lowercases what
 * the user types and renders the availability hint with the retry control, so
 * the three forms cannot drift apart. The availability itself comes from
 * `useSlugAvailability`, which the caller owns because the scope differs.
 */
export function SlugField({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus,
  availability,
  takenInWorkshop,
  retryLabel,
}: {
  id: string;
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  availability: SlugAvailability;
  /** Note shown under a free room slug that the workshop already uses. */
  takenInWorkshop?: React.ReactNode;
  /** Label of the retry control shown after a failed check. */
  retryLabel: React.ReactNode;
}) {
  const t = useTranslations();
  const hint = slugHintKey(availability.state);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {hint && (
        <p className={`text-xs ${slugHintClass(availability.state)}`}>
          {t(hint)}
        </p>
      )}
      {availability.state === "available" && takenInWorkshop && (
        <p className="text-xs text-muted-foreground">{takenInWorkshop}</p>
      )}
      {availability.state === "error" && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0 text-xs"
          onClick={availability.retry}
        >
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
