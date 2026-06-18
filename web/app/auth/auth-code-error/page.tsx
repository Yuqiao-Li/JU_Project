import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Wordmark } from "@/components/brand/wordmark";

/** Reasons the callback can forward; anything else falls back to "expired". */
type Reason = "cancelled" | "expired" | "server";

function reasonKey(raw: string | string[] | undefined): Reason {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "cancelled" || value === "server") return value;
  return "expired";
}

export default async function AuthCodeErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>;
}) {
  const { reason } = await searchParams;
  const t = await getTranslations("auth");
  const key = reasonKey(reason);

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm text-center">
        <Wordmark href="/" />
        <h1 className="mt-8 font-display text-xl font-bold text-paper">{t(`error.${key}.title`)}</h1>
        <p className="mt-2 text-sm text-muted">{t(`error.${key}.body`)}</p>
        <Link
          href="/login"
          className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105"
        >
          {t("backToSignIn")}
        </Link>
      </div>
    </main>
  );
}
