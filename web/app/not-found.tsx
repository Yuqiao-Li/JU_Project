import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Wordmark } from "@/components/brand/wordmark";

/**
 * Custom 404 (task 6.3).
 *
 * Renders for both explicit `notFound()` calls — a missing or taken-down event slug, or a
 * host event the viewer doesn't own — and any unmatched URL across the whole app. Most
 * guests arrive here from a mistyped or expired invite link, so the copy names that
 * plainly and offers one clear way back, rather than a vague apology (frontend-design:
 * "an empty screen is an invitation to act"). The aurora is the page's single flourish,
 * reused from the front door; reduced-motion stills it (globals.css).
 */
export default async function NotFound() {
  const t = await getTranslations("errors");

  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden px-5 py-20">
      <div
        aria-hidden
        className="aurora pointer-events-none absolute left-1/2 top-16 h-72 w-72 -translate-x-1/2"
      />
      <div className="relative w-full max-w-md text-center">
        <Wordmark href="/" className="text-2xl" />
        <p className="eyebrow mt-10">{t("notFound.eyebrow")}</p>
        <h1 className="mt-3 text-balance font-display text-3xl font-extrabold leading-tight text-paper sm:text-4xl">
          {t("notFound.title")}
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-balance text-muted">
          {t("notFound.body")}
        </p>
        <div className="mt-8 flex items-center justify-center">
          <Link
            href="/"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-coral px-7 font-semibold text-ink transition hover:brightness-105"
          >
            {t("notFound.cta")}
          </Link>
        </div>
      </div>
    </main>
  );
}
