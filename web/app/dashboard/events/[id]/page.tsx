import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CopyLinkButton } from "@/components/events/copy-link-button";
import { goingOccupancy, remainingSpots } from "@/lib/events/capacity";
import { formatEventWhen } from "@/lib/events/format";
import { createClient } from "@/lib/supabase/server";

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

const STATUS_LABELS: Record<string, string> = {
  going: "Going",
  maybe: "Maybe",
  not_going: "Can’t go",
  waitlisted: "Waitlist",
};

export default async function HostEventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

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

  // Live headcount + remaining seats from the shared capacity helper (task 3.2): each
  // going RSVP occupies 1 + its plus-ones; remaining is null when there's no cap.
  const goingCount = goingOccupancy(rsvps);
  const remaining = remainingSpots(event.capacity, goingCount);
  const isFull = remaining === 0;

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
      <Link href="/dashboard" className="text-sm text-muted transition hover:text-paper">
        ← Your events
      </Link>

      <div className="mt-6 flex items-center gap-3">
        <p className="eyebrow">Your event</p>
        <span className="rounded-full border border-line px-2.5 py-0.5 text-xs capitalize text-muted">
          {event.status}
        </span>
        {event.visibility === "private" && (
          <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">Private</span>
        )}
      </div>
      <h1 className="mt-2 text-balance font-display text-3xl font-extrabold text-paper">{event.title}</h1>
      <p className="mt-2 text-muted">{formatEventWhen(event.starts_at, event.date_tbd)}</p>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href={`/dashboard/events/${event.id}/edit`}
          className="inline-flex h-10 items-center justify-center rounded-lg border border-line px-4 text-sm font-semibold text-paper transition hover:bg-surface-2"
        >
          Edit event
        </Link>
      </div>

      <section className="mt-8 rounded-2xl border border-line bg-surface/60 p-5">
        <p className="text-sm text-muted">Public link — guests RSVP without an account.</p>
        <div className="mt-3">
          <CopyLinkButton slug={event.slug} />
        </div>
      </section>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Going" value={String(goingCount)} accent />
        <Stat label="Maybe" value={String(maybe.length)} />
        <Stat
          label={event.capacity != null ? "Spots left" : "Capacity"}
          value={event.capacity == null ? "No limit" : isFull ? "Full" : String(remaining)}
        />
      </section>

      {isFull && (
        <p className="mt-3 text-sm text-muted">
          This event is full — new replies join the waitlist. Promote a waitlisted guest below to open
          their spot.
        </p>
      )}

      <section className="mt-10">
        <h2 className="eyebrow">Guest list</h2>
        {going.length + maybe.length + declined.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No replies yet. Share the link to get the first RSVP.</p>
        ) : (
          <div className="mt-4 space-y-6">
            <GuestGroup status="going" rows={going} />
            <GuestGroup status="maybe" rows={maybe} />
            <GuestGroup status="not_going" rows={declined} />
          </div>
        )}
      </section>

      {waitlist.length > 0 && (
        <section className="mt-10">
          <h2 className="eyebrow">Waitlist · {waitlist.length}</h2>
          <p className="mt-1 text-sm text-muted">
            In line if a spot opens. Move someone up when there’s room.
          </p>
          <ul className="mt-4 divide-y divide-line/60 rounded-xl border border-line bg-surface/40">
            {waitlist.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-paper">
                    {r.guests?.display_name ?? "Guest"}
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
  hideHeading = false,
}: {
  status: string;
  rows: RsvpRow[];
  hideHeading?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      {!hideHeading && (
        <p className="text-sm font-semibold text-muted">
          {STATUS_LABELS[status] ?? status} · {rows.length}
        </p>
      )}
      <ul className="mt-2 divide-y divide-line/60 rounded-xl border border-line bg-surface/40">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-paper">
                {r.guests?.display_name ?? "Guest"}
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
