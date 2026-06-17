import Link from "next/link";
import { redirect } from "next/navigation";

import { signOut } from "@/app/auth/actions";
import { Wordmark } from "@/components/brand/wordmark";
import { groupEventsByTime, parseMyEvents, type MyEvent } from "@/lib/events/feed";
import { formatEventWhen } from "@/lib/events/format";
import { createClient } from "@/lib/supabase/server";

/**
 * The unified "your events" dashboard (task 2.3).
 *
 * One feed, the way Partiful does it: events I HOST (host_id) ∪ events I ATTEND
 * (guests.user_id), grouped upcoming / past, with host vs going told apart. The
 * data comes from get_my_events (SECURITY DEFINER, D1) over the host's OWN
 * authenticated client — auth.uid() is the only scope, so another host's events
 * can never appear (不串其他 host 的活动). The guard is re-checked here because
 * Server Components are reachable directly.
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

  const { data: feed, error } = await supabase.rpc("get_my_events");
  const events = error ? [] : parseMyEvents(feed);
  const { upcoming, past } = groupEventsByTime(events, new Date());
  const hasEvents = events.length > 0;

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
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Your events</p>
            <h1 className="mt-2 text-balance font-display text-3xl font-extrabold text-paper">
              Hey {greetingName}
            </h1>
          </div>
          <Link
            href="/dashboard/events/new"
            className="inline-flex h-11 items-center justify-center rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105"
          >
            New event
          </Link>
        </div>

        {!hasEvents ? (
          <div className="mt-8 rounded-2xl border border-line bg-surface/60 p-6">
            <p className="text-paper">No events yet.</p>
            <p className="mt-1 text-sm text-muted">
              Create your first event, publish it, and share the link — guests RSVP without an
              account.
            </p>
            {!profile?.username && (
              <Link
                href="/dashboard/settings"
                className="mt-4 inline-flex h-11 items-center justify-center rounded-xl border border-line px-5 font-semibold text-paper transition hover:bg-surface-2"
              >
                Choose your username
              </Link>
            )}
          </div>
        ) : (
          <div className="mt-10 space-y-12">
            <EventSection title="Upcoming" events={upcoming} emptyHint="Nothing on the calendar yet." />
            {past.length > 0 && <EventSection title="Past" events={past} muted />}
          </div>
        )}
      </main>
    </div>
  );
}

function EventSection({
  title,
  events,
  emptyHint,
  muted = false,
}: {
  title: string;
  events: MyEvent[];
  emptyHint?: string;
  muted?: boolean;
}) {
  return (
    <section>
      <h2 className="eyebrow">{title}</h2>
      {events.length === 0 ? (
        emptyHint && <p className="mt-3 text-sm text-muted">{emptyHint}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {events.map((event) => (
            <li key={event.id}>
              <EventCard event={event} muted={muted} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventCard({ event, muted }: { event: MyEvent; muted: boolean }) {
  const isHost = event.role === "host";
  // A host owns the event → land on the management detail page; an attendee opens
  // the public page they RSVP'd through (the slug is the shareable credential).
  const href = isHost ? `/dashboard/events/${event.id}` : `/${event.slug}`;
  const when = formatEventWhen(event.starts_at, event.date_tbd);

  return (
    <Link
      href={href}
      className={`block rounded-2xl border border-line bg-surface/60 p-5 transition hover:border-iris/50 hover:bg-surface ${
        muted ? "opacity-80" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <RoleBadge isHost={isHost} />
        {isHost && event.status !== "published" && (
          <span className="rounded-full border border-line px-2.5 py-0.5 text-xs capitalize text-muted">
            {event.status}
          </span>
        )}
        {event.visibility === "private" && (
          <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
            Private
          </span>
        )}
      </div>
      <h3 className="mt-3 font-display text-lg font-bold text-paper">{event.title}</h3>
      <p className="mt-1 text-sm text-muted">
        {when}
        {event.location_city ? ` · ${event.location_city}` : ""}
      </p>
    </Link>
  );
}

function RoleBadge({ isHost }: { isHost: boolean }) {
  return isHost ? (
    <span className="rounded-full bg-coral/15 px-2.5 py-0.5 text-xs font-semibold text-coral">
      Hosting
    </span>
  ) : (
    <span className="rounded-full bg-iris/15 px-2.5 py-0.5 text-xs font-semibold text-iris">
      Going
    </span>
  );
}
