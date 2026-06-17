import Link from "next/link";
import { redirect } from "next/navigation";

import { signOut } from "@/app/auth/actions";
import { Wordmark } from "@/components/brand/wordmark";
import { createClient } from "@/lib/supabase/server";

/**
 * Host dashboard shell (task 2.1). The authoritative guard: re-check the session
 * here, never trust the proxy alone. The full "your events" feed lands in 2.3 —
 * this proves sign-in, the guard, the auto-created profile, and sign-out.
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, username")
    .eq("id", user.id)
    .maybeSingle();

  const greetingName = profile?.display_name?.trim() || user.email?.split("@")[0] || "host";

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
        <Wordmark href="/dashboard" />
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/dashboard/settings" className="text-muted transition hover:text-paper">
            Settings
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-lg border border-line px-3 py-1.5 text-paper transition hover:bg-surface-2"
            >
              Sign out
            </button>
          </form>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
        <p className="eyebrow">Your events</p>
        <h1 className="mt-2 text-balance font-display text-3xl font-extrabold text-paper">
          Hey {greetingName} — what are we throwing?
        </h1>
        <p className="mt-3 text-muted">
          You&apos;re signed in. Spin up an event, share the link, and your guests RSVP without ever
          making an account.
        </p>

        <div className="mt-8 rounded-2xl border border-line bg-surface/60 p-6">
          <p className="text-paper">No events yet.</p>
          <p className="mt-1 text-sm text-muted">
            Create your first event, publish it, and share the link — guests RSVP without an account.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href="/dashboard/events/new"
              className="inline-flex h-11 items-center justify-center rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105"
            >
              New event
            </Link>
            {!profile?.username && (
              <Link
                href="/dashboard/settings"
                className="inline-flex h-11 items-center justify-center rounded-xl border border-line px-5 font-semibold text-paper transition hover:bg-surface-2"
              >
                Choose your username
              </Link>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
