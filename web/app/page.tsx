import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Wordmark } from "@/components/brand/wordmark";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  // Signed-in hosts go straight to their events.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  const t = await getTranslations("home");

  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden px-5 py-20">
      <div
        aria-hidden
        className="aurora pointer-events-none absolute left-1/2 top-16 h-80 w-80 -translate-x-1/2"
      />
      <LocaleSwitcher className="absolute right-5 top-5" />
      <div className="relative w-full max-w-lg text-center">
        <Wordmark href="/" className="text-3xl" />
        <h1 className="mt-8 text-balance font-display text-4xl font-extrabold leading-tight text-paper sm:text-5xl">
          {t("tagline")}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-balance text-muted">{t("subtitle")}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/login"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-coral px-7 font-semibold text-ink transition hover:brightness-105"
          >
            {t("cta")}
          </Link>
          <Link
            href="/discover"
            className="inline-flex h-12 items-center justify-center rounded-xl border border-line px-7 font-semibold text-paper transition hover:border-iris/60 hover:bg-surface/60"
          >
            {t("browseEvents")}
          </Link>
        </div>
        <p className="mt-6 text-xs text-muted">{t("note")}</p>
      </div>
    </main>
  );
}
