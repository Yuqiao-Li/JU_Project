import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { CopyLinkButton } from "@/components/events/copy-link-button";
import { LocalWhen } from "@/components/events/local-when";
import { goingOccupancy, remainingSpots } from "@/lib/events/capacity";
import { createClient } from "@/lib/supabase/server";

import { CopyContactsButton, type GuestContact } from "./copy-contacts-button";
import { EventLifecycle } from "./event-lifecycle";
import { PromoteButton } from "./promote-button";

/**
 * Host event detail (task 2.3).
 *
 * The management view for an event the host owns: the public link to share, the
 * live headcount, and the FULL guest list — host-only, so it includes contact
 * (M1) and the Can't-Go / waitlist rows a guest never sees. Everything loads over
 * the host's own RLS path (USING host_id = auth.uid()), so a non-owner simply gets
 * no rows → notFound(); contact never leaves the host boundary.
 */

type GuestEmbed = { display_name: string; contact: string | null } | null;
type RsvpRow = {
  id: string;
  status: string;
  plus_ones: number;
  guests: GuestEmbed;
};

type Translator = Awaited<ReturnType<typeof getTranslations>>;

const STATUS_LABEL_KEYS: Record<string, string> = {
  going: "statusGoing",
  maybe: "statusMaybe",
  not_going: "statusNotGoing",
  waitlisted: "statusWaitlisted",
};

export default async function HostEventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations("hostEvent");
  const common = await getTranslations("common");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/dashboard/events/${id}`);

  const { data: event } = await supabase
    .from("events")
    .select("id, slug, title, status, visibility, starts_at, date_tbd, capacity")
    .eq("id", id)
    .maybeSingle();
  if (!event) notFound();

  // Full guest list over the host RLS path — contact rides along (host-only, M1).
  const { data: rsvpData } = await supabase
    .from("rsvps")
    .select("id, status, plus_ones, guests(display_name, contact)")
    .eq("event_id", id)
    .order("created_at", { ascending: true });
  const rsvps = (rsvpData ?? []) as RsvpRow[];

  const going = rsvps.filter((r) => r.status === "going");
  const maybe = rsvps.filter((r) => r.status === "maybe");
  const declined = rsvps.filter((r) => r.status === "not_going");
  const waitlist = rsvps.filter((r) => r.status === "waitlisted");

  // Contacts for "copy all" (audit H11): everyone who left one (host-only data).
  const contacts: GuestContact[] = [...going, ...maybe, ...waitlist]
    .map((r) => ({ name: r.guests?.display_name ?? "", contact: r.guests?.contact ?? "" }))
    .filter((c) => c.contact !== "");

  // Live headcount + remaining seats from the shared capacity helper (task 3.2): each
  // going RSVP occupies 1 + its plus-ones; remaining is null when there's no cap.
  const goingCount = goingOccupancy(rsvps);
  const remaining = remainingSpots(event.capacity, goingCount);
  const isFull = remaining === 0;

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
      <Link href="/dashboard" className="text-sm text-muted transition hover:text-paper">
        {t("backToEvents")}
      </Link>

      <div className="mt-6 flex items-center gap-3">
        <p className="eyebrow">{t("eyebrow")}</p>
        <span className="rounded-full border border-line px-2.5 py-0.5 text-xs capitalize text-muted">
          {event.status}
        </span>
        {event.visibility === "private" && (
          <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">{t("private")}</span>
        )}
      </div>
      <h1 className="mt-2 text-balance font-display text-3xl font-extrabold text-paper">{event.title}</h1>
      <p className="mt-2 text-muted">
        <LocalWhen
          iso={event.date_tbd ? null : event.starts_at}
          tbdLabel={common("dateTbd")}
        />
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href={`/dashboard/events/${event.id}/edit`}
          className="inline-flex h-10 items-center justify-center rounded-lg border border-line px-4 text-sm font-semibold text-paper transition hover:bg-surface-2"
        >
          {t("editEvent")}
        </Link>
      </div>

      <div className="mt-3">
        <EventLifecycle eventId={event.id} status={event.status} />
      </div>

      <section className="mt-8 rounded-2xl border border-line bg-surface/60 p-5">
        <p className="text-sm text-muted">{t("publicLinkHint")}</p>
        {event.status !== "published" && (
          <p className="mt-2 text-sm text-amber">{t("draftLinkHint")}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <CopyLinkButton slug={event.slug} />
          {event.status === "published" && (
            <a
              href={`/${event.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-iris underline-offset-2 hover:underline"
            >
              {t("previewAsGuest")}
            </a>
          )}
        </div>
      </section>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t("statGoing")} value={String(goingCount)} accent />
        <Stat label={t("statMaybe")} value={String(maybe.length)} />
        <Stat
          label={event.capacity != null ? t("statSpotsLeft") : t("statCapacity")}
          value={event.capacity == null ? t("noLimit") : isFull ? t("full") : String(remaining)}
        />
      </section>

      {isFull && <p className="mt-3 text-sm text-muted">{t("fullNotice")}</p>}

      <section className="mt-10">
        <div className="flex items-center justify-between gap-3">
          <h2 className="eyebrow">{t("guestList")}</h2>
          <CopyContactsButton contacts={contacts} />
        </div>
        {going.length + maybe.length + declined.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t("noReplies")}</p>
        ) : (
          <div className="mt-4 space-y-6">
            <GuestGroup status="going" rows={going} t={t} />
            <GuestGroup status="maybe" rows={maybe} t={t} />
            <GuestGroup status="not_going" rows={declined} t={t} />
          </div>
        )}
      </section>

      {waitlist.length > 0 && (
        <section className="mt-10">
          <h2 className="eyebrow">{t("waitlistHeading", { count: waitlist.length })}</h2>
          <p className="mt-1 text-sm text-muted">{t("waitlistHint")}</p>
          <ul className="mt-4 divide-y divide-line/60 rounded-xl border border-line bg-surface/40">
            {waitlist.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-paper">
                    {r.guests?.display_name ?? t("guestFallback")}
                    {r.plus_ones > 0 && <span className="ml-1 text-sm text-muted">+{r.plus_ones}</span>}
                  </p>
                  {r.guests?.contact && <p className="truncate text-sm text-muted">{r.guests.contact}</p>}
                </div>
                <PromoteButton rsvpId={r.id} eventId={event.id} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface/40 px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className={`mt-1 font-display text-2xl font-bold ${accent ? "text-coral" : "text-paper"}`}>{value}</p>
    </div>
  );
}

function GuestGroup({
  status,
  rows,
  t,
  hideHeading = false,
}: {
  status: string;
  rows: RsvpRow[];
  t: Translator;
  hideHeading?: boolean;
}) {
  if (rows.length === 0) return null;
  const labelKey = STATUS_LABEL_KEYS[status];
  const label = labelKey ? t(labelKey) : status;
  return (
    <div>
      {!hideHeading && (
        <p className="text-sm font-semibold text-muted">
          {label} · {rows.length}
        </p>
      )}
      <ul className="mt-2 divide-y divide-line/60 rounded-xl border border-line bg-surface/40">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-paper">
                {r.guests?.display_name ?? t("guestFallback")}
                {r.plus_ones > 0 && <span className="ml-1 text-sm text-muted">+{r.plus_ones}</span>}
              </p>
              {r.guests?.contact && <p className="truncate text-sm text-muted">{r.guests.contact}</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
