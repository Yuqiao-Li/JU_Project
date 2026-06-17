"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { LOCALE_COOKIE, locales, type Locale } from "@/i18n/config";

const LABELS: Record<Locale, string> = { zh: "中", en: "EN" };

/**
 * Language toggle. Sets the NEXT_LOCALE cookie (no URL routing) and refreshes so
 * the server re-renders in the chosen locale. Used in page headers / footers.
 */
export function LocaleSwitcher({ className = "" }: { className?: string }) {
  const active = useLocale();
  const router = useRouter();
  const t = useTranslations("common");
  const [pending, startTransition] = useTransition();

  function choose(locale: Locale) {
    if (locale === active) return;
    document.cookie = `${LOCALE_COOKIE}=${locale};path=/;max-age=31536000;samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div
      role="group"
      aria-label={t("language")}
      className={`inline-flex items-center rounded-full border border-line bg-surface/60 p-0.5 text-sm ${className}`}
    >
      {locales.map((locale) => {
        const isActive = locale === active;
        return (
          <button
            key={locale}
            type="button"
            onClick={() => choose(locale)}
            aria-pressed={isActive}
            disabled={pending}
            className={`min-w-9 rounded-full px-3 py-1 font-medium transition disabled:opacity-60 ${
              isActive ? "bg-coral text-ink" : "text-muted hover:text-paper"
            }`}
          >
            {LABELS[locale]}
          </button>
        );
      })}
    </div>
  );
}
