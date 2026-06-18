import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { signOut } from "@/app/auth/actions";
import { Wordmark } from "@/components/brand/wordmark";
import { LocalWhen } from "@/components/events/local-when";
import { groupEventsByTime, parseMyEvents, type MyEvent } from "@/lib/events/feed";
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

  const t = await getTranslations("dashboard");
  const common = await getTranslations("common");
  const dateTbdLabel = common("dateTbd");

  const greetingName = profile?.display_name?.trim() || user.email?.split("@")[0] || "host";

  const { data: feed, error } = await supabase.rpc("get_my_events");
  // A real RPC failure must NOT collapse into the cheerful empty state — that
  // would hide existing events behind "No events yet" on a transient blip. Throw
  // so the route error boundary (app/error.tsx) shows an error + retry (H20).
  if (error) {
    console.error("[dashboard] get_my_events failed:", error.message);
    throw new Error("Failed to load your events");
  }
  const events = parseMyEvents(feed);
  const { upcoming, past } = groupEventsByTime(events, new Date());
  const hasEvents = events.length > 0;

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
        <Wordmark href="/dashboard" />
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/dashboard/settings" className="text-muted transition hover:text-paper">
            {t("nav.settings")}
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-lg border border-line px-3 py-1.5 text-paper transition hover:bg-surface-2"
            >
              {t("nav.signOut")}
            </button>
          </form>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">{t("eyebrow")}</p>
            <h1 className="mt-2 text-balance font-display text-3xl font-extrabold text-paper">
              {t("greeting", { name: greetingName })}
            </h1>
          </div>
          <Link
            href="/dashboard/events/new"
            className="inline-flex h-11 items-center justify-center rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105"
          >
            {t("newEvent")}
          </Link>
        </div>

        {!hasEvents ? (
          <div className="mt-8 rounded-2xl border border-line bg-surface/60 p-6">
            <p className="text-paper">{t("empty.title")}</p>
            <p className="mt-1 text-sm text-muted">{t("empty.body")}</p>
            {!profile?.username && (
              <Link
                href="/dashboard/settings"
                className="mt-4 inline-flex h-11 items-center justify-center rounded-xl border border-line px-5 font-semibold text-paper transition hover:bg-surface-2"
              >
                {t("empty.chooseUsername")}
              </Link>
            )}
          </div>
        ) : (
          <div className="mt-10 space-y-12">
            <EventSection
              title={t("sections.upcoming")}
              events={upcoming}
              emptyHint={t("sections.upcomingEmpty")}
              roleLabels={{ hosting: t("role.hosting"), going: t("role.going") }}
              privateLabel={t("badge.private")}
              locationSeparator={t("card.locationSeparator")}
              dateTbdLabel={dateTbdLabel}
              t={t}
            />
            {past.length > 0 && (
              <EventSection
                title={t("sections.past")}
                events={past}
                muted
                roleLabels={{ hosting: t("role.hosting"), going: t("role.going") }}
                privateLabel={t("badge.private")}
                locationSeparator={t("card.locationSeparator")}
                dateTbdLabel={dateTbdLabel}
                t={t}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

type RoleLabels = { hosting: string; going: string };
type Translator = Awaited<ReturnType<typeof getTranslations>>;

function EventSection({
  title,
  events,
  emptyHint,
  muted = false,
  roleLabels,
  privateLabel,
  locationSeparator,
  dateTbdLabel,
  t,
}: {
  title: string;
  events: MyEvent[];
  emptyHint?: string;
  muted?: boolean;
  roleLabels: RoleLabels;
  privateLabel: string;
  locationSeparator: string;
  dateTbdLabel: string;
  t: Translator;
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
              <EventCard
                event={event}
                muted={muted}
                roleLabels={roleLabels}
                privateLabel={privateLabel}
                locationSeparator={locationSeparator}
                dateTbdLabel={dateTbdLabel}
                t={t}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventCard({
  event,
  muted,
  roleLabels,
  privateLabel,
  locationSeparator,
  dateTbdLabel,
  t,
}: {
  event: MyEvent;
  muted: boolean;
  roleLabels: RoleLabels;
  privateLabel: string;
  locationSeparator: string;
  dateTbdLabel: string;
  t: Translator;
}) {
  const isHost = event.role === "host";
  // A host owns the event → land on the management detail page; an attendee opens
  // the public page they RSVP'd through (the slug is the shareable credential).
  const href = isHost ? `/dashboard/events/${event.id}` : `/${event.slug}`;
  const whenIso = event.date_tbd ? null : event.starts_at;

  return (
    <Link
      href={href}
      className={`block rounded-2xl border border-line bg-surface/60 p-5 transition hover:border-iris/50 hover:bg-surface ${
        muted ? "opacity-80" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <RoleBadge isHost={isHost} labels={roleLabels} />
        {isHost && event.status !== "published" && (
          <span className="rounded-full border border-line px-2.5 py-0.5 text-xs capitalize text-muted">
            {event.status}
          </span>
        )}
        {event.visibility === "private" && (
          <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
            {privateLabel}
          </span>
        )}
      </div>
      <h3 className="mt-3 font-display text-lg font-bold text-paper">{event.title}</h3>
      <p className="mt-1 text-sm text-muted">
        <LocalWhen iso={whenIso} tbdLabel={dateTbdLabel} />
        {event.location_city ? `${locationSeparator}${event.location_city}` : ""}
      </p>
      {isHost && typeof event.going_count === "number" && (
        <p className="mt-2 text-sm text-paper">
          {t("card.goingCount", { count: event.going_count })}
          {event.waitlist_count ? ` · ${t("card.waitlistCount", { count: event.waitlist_count })}` : ""}
          {event.maybe_count ? ` · ${t("card.maybeCount", { count: event.maybe_count })}` : ""}
        </p>
      )}
    </Link>
  );
}

function RoleBadge({ isHost, labels }: { isHost: boolean; labels: RoleLabels }) {
  return isHost ? (
    <span className="rounded-full bg-coral/15 px-2.5 py-0.5 text-xs font-semibold text-coral">
      {labels.hosting}
    </span>
  ) : (
    <span className="rounded-full bg-iris/15 px-2.5 py-0.5 text-xs font-semibold text-iris">
      {labels.going}
    </span>
  );
}
