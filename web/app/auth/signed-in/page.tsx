import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Wordmark } from "@/components/brand/wordmark";
import { safeNext } from "@/lib/auth/safe-next";

/**
 * Confirmation shown in the tab opened by an email magic link. Auth has already
 * completed in the callback route; this is a friendly "you're signed in" landing
 * (not the dashboard) so the host can hop back to the tab they started in — the
 * original tab redirects itself once it detects the session. A primary button
 * still lets them jump to their events from here.
 */
export default async function SignedInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: nextParam } = await searchParams;
  const next = safeNext(nextParam);
  const t = await getTranslations("auth");

  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden px-5 py-16">
      {/* Signature: the party light behind the wordmark. */}
      <div
        aria-hidden
        className="aurora pointer-events-none absolute left-1/2 top-24 h-72 w-72 -translate-x-1/2"
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <Wordmark href="/" className="text-3xl" />
        </div>

        <div className="rounded-2xl border border-line bg-surface/70 p-6 text-center">
          <h1 className="font-display text-xl font-bold text-paper">{t("signedInTitle")}</h1>
          <p className="mt-2 text-sm text-muted">{t("signedInBody")}</p>
          <Link
            href={next}
            className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105"
          >
            {t("signedInCta")}
          </Link>
        </div>
      </div>
    </main>
  );
}
