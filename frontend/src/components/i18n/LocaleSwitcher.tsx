"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALE_COOKIE, locales, type Locale } from "@/i18n/config";

const LABELS: Record<Locale, string> = { en: "English", ru: "Русский" };

export function LocaleSwitcher({ className = "" }: { className?: string }) {
  const locale = useLocale() as Locale;
  const t = useTranslations("Common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function switchTo(next: Locale) {
    if (next === locale) return;
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax${secure}`;
    startTransition(() => router.refresh());
  }

  return (
    <div
      role="group"
      aria-label={t("language")}
      className={`flex items-center gap-1 rounded-md border border-white/20 bg-black/40 p-1 text-xs ${className}`}
    >
      {locales.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={value === locale}
          disabled={pending}
          onClick={() => switchTo(value)}
          className={
            value === locale
              ? "rounded px-2 py-1 text-white"
              : "rounded px-2 py-1 text-white/60 hover:text-white"
          }
        >
          {LABELS[value]}
        </button>
      ))}
    </div>
  );
}
