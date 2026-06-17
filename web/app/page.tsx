import Link from "next/link";
import { redirect } from "next/navigation";

import { Wordmark } from "@/components/brand/wordmark";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  // Signed-in hosts go straight to their events.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden px-5 py-20">
      <div
        aria-hidden
        className="aurora pointer-events-none absolute left-1/2 top-16 h-80 w-80 -translate-x-1/2"
      />
      <div className="relative w-full max-w-lg text-center">
        <Wordmark href="/" className="text-3xl" />
        <h1 className="mt-8 text-balance font-display text-4xl font-extrabold leading-tight text-paper sm:text-5xl">
          Throw something good.
        </h1>
        <p className="mx-auto mt-4 max-w-md text-balance text-muted">
          Make an event, share one link, and watch the yeses roll in. Your guests RSVP in seconds —
          no account, no app.
        </p>
        <div className="mt-8 flex items-center justify-center">
          <Link
            href="/login"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-coral px-7 font-semibold text-ink transition hover:brightness-105"
          >
            Start hosting
          </Link>
        </div>
        <p className="mt-6 text-xs text-muted">Hosting needs an account. Guests never sign in.</p>
      </div>
    </main>
  );
}
