import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { signOut } from "@/app/auth/actions";
import { Wordmark } from "@/components/brand/wordmark";
import { EventCard } from "@/components/events/event-card";
import { LocalWhen } from "@/components/events/local-when";
import { groupEventsByTime, parseMyEvents, type MyEvent } from "@/lib/events/feed";
import { isEventLocked } from "@/lib/events/lock";
import { createClient } from "@/lib/supabase/server";

/**
 * The host's "current/latest" hosted event for the 局卡顶 hero (dashboard.md): the most
 * recent ACTIVE (published) event they host — the soonest upcoming one, else the most
 * recently-finished one. Drafts/cancelled events and events they merely attend don't get
 * the hero. null when there's none to feature (the hero renders nothing then).
 */
function pickHeroEvent(upcoming: MyEvent[], past: MyEvent[]): MyEvent | null {
  const isLiveHost = (e: MyEvent) => e.role === "host" && e.status === "published";
  // upcoming is soonest-first, past is most-recent-first (groupEventsByTime), so the first
  // live-host match in each already gives the right "current, else latest" pick.
  return upcoming.find(isLiveHost) ?? past.find(isLiveHost) ?? null;
}

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
  const now = new Date();
  const { upcoming, past } = groupEventsByTime(events, now);
  const hasEvents = events.length > 0;

  // 局卡顶 (dashboard.md): feature the host's current/latest published event with the shared
  // 局卡. The feed lacks capacity + lock state, so read just those two for the hero over the
  // host's own RLS path (a non-owner row can't appear — the hero id came from their own feed).
  const hero = pickHeroEvent(upcoming, past);
  let heroCapacity: number | null = null;
  let heroLocked = false;
  if (hero) {
    const { data: heroRow } = await supabase
      .from("events")
      .select("capacity, locked_at, starts_at")
      .eq("id", hero.id)
      .maybeSingle();
    heroCapacity = heroRow?.capacity ?? null;
    heroLocked = isEventLocked(heroRow?.locked_at ?? null, heroRow?.starts_at ?? null, now);
  }

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

        {hero && (
          <section className="mt-10">
            <EventCard
              mode="host"
              slug={hero.slug}
              capacity={heroCapacity}
              goingCount={hero.going_count ?? 0}
              isLocked={heroLocked}
              unlocked={undefined}
              record={null}
            />
            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
              <Link
                href={`/dashboard/events/${hero.id}`}
                className="font-semibold text-iris underline-offset-2 hover:underline"
              >
                {t("hero.manage")}
              </Link>
              <Link
                href={`/dashboard/events/new?from=${hero.id}`}
                className="font-semibold text-iris underline-offset-2 hover:underline"
              >
                {t("hero.reuse")}
              </Link>
            </div>
          </section>
        )}

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
              <EventListRow
                event={event}
                muted={muted}
                roleLabels={roleLabels}
                privateLabel={privateLabel}
                locationSeparator={locationSeparator}
                dateTbdLabel={dateTbdLabel}
                t={t}
              />
              {/* 再开一局: a small clone affordance on each HOSTED row (a sibling, not nested
                  in the row Link), leaving the list's open-this-event semantics untouched. */}
              {event.role === "host" && (
                <Link
                  href={`/dashboard/events/new?from=${event.id}`}
                  className="mt-1.5 ml-1 inline-block text-xs font-semibold text-muted underline-offset-2 transition hover:text-iris hover:underline"
                >
                  {t("hero.reuse")}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventListRow({
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
