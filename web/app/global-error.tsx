"use client";

import { NextIntlClientProvider, useTranslations } from "next-intl";
import { useEffect } from "react";

import enMessages from "@/messages/en.json";
import zhMessages from "@/messages/zh.json";

import "./globals.css";

/**
 * Global error boundary (task 6.3) — catches an error thrown by the ROOT layout itself,
 * which `app/error.tsx` cannot (an error boundary never wraps its own segment's layout).
 * It replaces the root layout when active, so it must render its own `<html>`/`<body>`
 * and pull in the global stylesheet for the brand tokens. The display font isn't loaded
 * here (next/font lives in the replaced layout), so type falls back to the system stack —
 * acceptable for a last-resort screen. Same posture as the route boundary: log it, offer
 * a retry, keep the copy generic.
 *
 * Because this replaces the root layout it also renders OUTSIDE the request's
 * `NextIntlClientProvider`, so we re-establish one here. The locale comes from the
 * `NEXT_LOCALE` cookie (read on the client; defaults to zh), and both catalogs are bundled
 * so the last-resort screen never depends on a network fetch.
 */
function readLocale(): "zh" | "en" {
  if (typeof document === "undefined") return "zh";
  const match = document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=(zh|en)/);
  return match?.[1] === "en" ? "en" : "zh";
}

function GlobalErrorContent({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("errors");

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-20">
      <div className="w-full max-w-md text-center">
        <p className="font-display text-2xl font-extrabold tracking-tight text-paper">
          JU<span className="text-coral">*</span>
        </p>
        <h1 className="mt-10 font-display text-3xl font-extrabold text-paper">
          {t("generic.title")}
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-muted">{t("global.body")}</p>
        <div className="mt-8 flex items-center justify-center">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-12 items-center justify-center rounded-xl bg-coral px-7 font-semibold text-ink transition hover:brightness-105"
          >
            {t("actions.retry")}
          </button>
        </div>
      </div>
    </main>
  );
}

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const locale = readLocale();
  const messages = locale === "en" ? enMessages : zhMessages;

  return (
    <html lang={locale}>
      <body className="min-h-screen bg-ink text-paper antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <GlobalErrorContent onRetry={() => unstable_retry()} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
