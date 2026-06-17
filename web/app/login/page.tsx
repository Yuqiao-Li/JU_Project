import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { LoginForm } from "@/components/auth/login-form";
import { Wordmark } from "@/components/brand/wordmark";
import { safeNext } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: nextParam } = await searchParams;
  const next = safeNext(nextParam);

  // Already signed in? Skip the form.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect(next);

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
          <p className="mt-3 text-balance text-sm text-muted">{t("tagline")}</p>
        </div>

        <LoginForm next={next} />

        <p className="mt-8 text-center text-xs leading-relaxed text-muted">{t("guestNote")}</p>
      </div>
    </main>
  );
}
