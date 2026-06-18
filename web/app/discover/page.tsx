import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { Wordmark } from "@/components/brand/wordmark";
import { PublicEventCard } from "@/components/events/public-event-card";
import { LocaleSwitcher } from "@/components/locale-switcher";
import {
  groupPublicEventsByTime,
  type PublicEvent,
} from "@/lib/events/public-events";
import { readAllPublicEvents } from "@/lib/events/read-public-events";
import { createClient } from "@/lib/supabase/server";

/**
 * Site-wide event DISCOVERY — `/discover` (Round-3 #6).
 *
 * Anyone (logged in or NOT) can browse EVERY public + published event. This is a
 * PUBLIC page — there is deliberately NO getUser→redirect; login only ever gates
 * CREATION, never viewing. The data comes ONLY from get_public_events (SECURITY
 * DEFINER) via readAllPublicEvents — anon never queries `events` directly, and the
 * RPC returns nothing but public + published events (first-tier façade fields only,
 * plus the host's display name), so a private/draft event and its full address can
 * never surface here.
 *
 * The "新建活动" button is the one place auth matters: a signed-in host goes
 * straight to the create form; an unauthenticated visitor is sent to /login first,
 * then on to create via ?next.
 *
 * Reads live (no caching) so a freshly published event shows up immediately.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("discover");
  return { title: `${t("title")} · JU` };
}

const CREATE_PATH = "/dashboard/events/new";

export default async function DiscoverPage() {
  const t = await getTranslations("discover");
  const common = await getTranslations("common");
  const dateTbdLabel = common("dateTbd");

  // Auth check gates ONLY the create button's destination — never the page itself.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const createHref = user
    ? CREATE_PATH
    : `/login?next=${encodeURIComponent(CREATE_PATH)}`;

  const events = await readAllPublicEvents();
  const { upcoming, past } = groupPublicEventsByTime(events, new Date());
  const hasEvents = events.length > 0;

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
        <Wordmark href="/" />
        <div className="flex items-center gap-4">
          <LocaleSwitcher />
          <Link
            href={createHref}
            className="inline-flex h-10 items-center justify-center rounded-xl bg-coral px-5 text-sm font-semibold text-ink transition hover:brightness-105"
          >
            {t("createCta")}
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-12 sm:px-8">
        <div>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
            {t("title")}
          </h1>
          <p className="mt-3 max-w-xl text-balance text-muted">{t("subtitle")}</p>
        </div>

        {!hasEvents ? (
          <div className="mt-10 rounded-2xl border border-line bg-surface/60 p-6">
            <p className="text-paper">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted">{t("emptyBody")}</p>
          </div>
        ) : (
          <div className="mt-10 space-y-12">
            <EventSection events={upcoming} dateTbdLabel={dateTbdLabel} hostedBy={t} />
            {past.length > 0 && (
              <EventSection
                events={past}
                dateTbdLabel={dateTbdLabel}
                hostedBy={t}
                title={t("past")}
                muted
              />
            )}
          </div>
        )}
      </main>

      <footer className="mt-auto px-5 py-8 text-center">
        <Link
          href="/"
          className="font-display text-sm font-bold tracking-tight text-muted transition hover:text-paper"
        >
          made with JU<span className="text-coral">*</span>
        </Link>
      </footer>
    </div>
  );
}

function EventSection({
  events,
  dateTbdLabel,
  hostedBy,
  title,
  muted = false,
}: {
  events: PublicEvent[];
  dateTbdLabel: string;
  hostedBy: Awaited<ReturnType<typeof getTranslations>>;
  title?: string;
  muted?: boolean;
}) {
  if (events.length === 0) return null;
  return (
    <section>
      {title && <h2 className="eyebrow">{title}</h2>}
      <ul className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${title ? "mt-4" : ""}`}>
        {events.map((event) => (
          <li key={event.id}>
            <PublicEventCard
              event={event}
              muted={muted}
              dateTbdLabel={dateTbdLabel}
              hostedByLabel={
                event.host_display_name
                  ? hostedBy("hostedBy", { name: event.host_display_name })
                  : undefined
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
