import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { Wordmark } from "@/components/brand/wordmark";
import { formatEventWhen } from "@/lib/events/format";
import {
  groupPublicEventsByTime,
  type PublicEvent,
} from "@/lib/events/public-events";
import { readPublicEventsByHost } from "@/lib/events/read-public-events";
import { normalizeUsername } from "@/lib/profile/username";

/**
 * Organizer Profile — `/u/[username]` (task 6.1).
 *
 * Lists a host's PUBLIC events. The data comes ONLY from get_public_events_by_host
 * (SECURITY DEFINER, D2) via readPublicEventsByHost — anon never queries `events`
 * directly (不 anon 直查表), and the RPC returns nothing but public + published events,
 * so a private/draft event and its full address can never surface here.
 *
 * NO EXISTENCE ORACLE (D2): an unknown username and a real host with no public events
 * both resolve to an empty list, so they render the SAME empty profile — we never 404
 * on a missing handle, which would leak whether it exists.
 *
 * DESIGN: this lives inside the app's established identity (DESIGN-TONE / globals.css) —
 * the same plum-ink surfaces, coral/iris accents, and card system as the dashboard.
 * Boldness is spent on the front-door aurora, not here; the profile stays quiet, with a
 * single warm monogram as its one flourish. Reads live (no caching) so a freshly
 * published event shows up.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}): Promise<Metadata> {
  const { username } = await params;
  const handle = normalizeUsername(decodeURIComponent(username));
  // Title only — a profile surfaces public events; nothing here is address-tier.
  return { title: `@${handle} · partiful` };
}

export default async function OrganizerProfilePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  // Stored handles are lowercased on save (lib/profile/username), and the RPC matches
  // exactly — so normalize the URL segment to resolve `/u/Rain` and `/u/rain` alike.
  const handle = normalizeUsername(decodeURIComponent(username));
  const t = await getTranslations("organizer");

  const events = await readPublicEventsByHost(handle);
  const { upcoming, past } = groupPublicEventsByTime(events, new Date());
  const hasEvents = events.length > 0;
  const monogram = handle.charAt(0).toUpperCase() || "?";

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
        <Wordmark href="/" />
        <Link
          href="/login"
          className="text-sm text-muted transition hover:text-paper"
        >
          {t("hostYourOwn")}
        </Link>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
        <div className="flex items-center gap-4">
          <span
            aria-hidden
            className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-coral to-iris font-display text-2xl font-extrabold text-ink"
          >
            {monogram}
          </span>
          <div>
            <p className="eyebrow">{t("eyebrow")}</p>
            <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-paper">
              @{handle}
            </h1>
          </div>
        </div>

        {!hasEvents ? (
          <div className="mt-10 rounded-2xl border border-line bg-surface/60 p-6">
            <p className="text-paper">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted">{t("emptyBody")}</p>
          </div>
        ) : (
          <div className="mt-10 space-y-12">
            <EventSection title={t("upcoming")} events={upcoming} />
            {past.length > 0 && (
              <EventSection title={t("past")} events={past} muted />
            )}
          </div>
        )}
      </main>

      <footer className="mt-auto px-5 py-8 text-center">
        <Link
          href="/"
          className="font-display text-sm font-bold tracking-tight text-muted transition hover:text-paper"
        >
          made with partiful<span className="text-coral">*</span>
        </Link>
      </footer>
    </div>
  );
}

function EventSection({
  title,
  events,
  muted = false,
}: {
  title: string;
  events: PublicEvent[];
  muted?: boolean;
}) {
  if (events.length === 0) return null;
  return (
    <section>
      <h2 className="eyebrow">{title}</h2>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2">
        {events.map((event) => (
          <li key={event.id}>
            <EventCard event={event} muted={muted} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function EventCard({ event, muted }: { event: PublicEvent; muted: boolean }) {
  const when = formatEventWhen(event.starts_at, event.date_tbd);
  return (
    <Link
      href={`/${event.slug}`}
      className={`group block overflow-hidden rounded-2xl border border-line bg-surface/60 transition hover:border-iris/50 hover:bg-surface ${
        muted ? "opacity-80" : ""
      }`}
    >
      <div
        className="aspect-[16/9] w-full bg-surface-2 bg-cover bg-center"
        style={
          event.cover_image_url
            ? { backgroundImage: `url(${JSON.stringify(event.cover_image_url)})` }
            : undefined
        }
      >
        {!event.cover_image_url && (
          <div className="h-full w-full bg-gradient-to-br from-iris/25 via-surface-2 to-coral/20" />
        )}
      </div>
      <div className="p-5">
        <h3 className="font-display text-lg font-bold text-paper">{event.title}</h3>
        <p className="mt-1 text-sm text-muted">
          {when}
          {event.location_city ? ` · ${event.location_city}` : ""}
        </p>
      </div>
    </Link>
  );
}
