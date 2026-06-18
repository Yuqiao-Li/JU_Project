import { z } from "zod";

/**
 * The Organizer Profile feed (task 6.1, `/u/[username]`).
 *
 * `get_public_events_by_host` (SECURITY DEFINER, D2) returns a jsonb array of a
 * host's PUBLIC + PUBLISHED events only — never private, draft, or cancelled, and
 * never another host's. This module is the boundary: it validates that payload with
 * zod so a forged / garbled response never reaches the view, and shapes it into the
 * upcoming / past groups the profile renders. Kept pure (only `zod`) so it unit-tests
 * without a database and stays importable from a test file.
 *
 * SECURITY NOTE: the schema models ONLY first-tier façade fields. It deliberately has
 * no `visibility`, `status`, `host_id`, `location_text`, or `contact` — so even if a
 * buggy or forged payload smuggled those in, zod strips them here before anything can
 * render private metadata on a public page (the address tiering, SCHEMA §get_event_by_slug).
 */

const publicEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  cover_image_url: z.string().nullable(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  date_tbd: z.boolean(),
  location_city: z.string().nullable(),
  // Site-wide discovery (Round-3 #6, get_public_events) adds the host's display
  // name so a card can show who's hosting. OPTIONAL so the per-host profile path
  // (get_public_events_by_host), which omits it, still parses. Still first-tier:
  // a public display name, never an identity/contact field.
  host_display_name: z.string().nullable().optional(),
});

export type PublicEvent = z.infer<typeof publicEventSchema>;

/**
 * Validate the get_public_events_by_host jsonb at the boundary. An unexpected shape
 * (null, a string, a row missing fields) collapses to [] rather than throwing — the
 * profile degrades to its empty state instead of crashing. Unknown keys are stripped
 * (z.object default), so no non-public field survives onto the page.
 */
export function parsePublicEvents(payload: unknown): PublicEvent[] {
  const result = z.array(publicEventSchema).safeParse(payload);
  return result.success ? result.data : [];
}

export interface GroupedPublicEvents {
  upcoming: PublicEvent[];
  past: PublicEvent[];
}

/**
 * The instant an event is "over", in epoch ms — its ends_at, else its starts_at. A
 * date-TBD or undated event has no such instant (null): it hasn't happened yet, so it
 * always counts as upcoming. A stale starts_at on a date_tbd event is ignored.
 */
function endMs(e: PublicEvent): number | null {
  if (e.date_tbd) return null;
  const when = e.ends_at ?? e.starts_at;
  if (!when) return null;
  const ms = Date.parse(when);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch ms of the start (for ordering upcoming); null = undated/TBD (sorts last). */
function startMs(e: PublicEvent): number | null {
  if (e.date_tbd) return null;
  if (!e.starts_at) return null;
  const ms = Date.parse(e.starts_at);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Split the public list into upcoming vs past around `now`. Upcoming sorts soonest-
 * first with undated/TBD last; past sorts most-recent-first. An event is past only
 * when it has a concrete end before `now`. Same time semantics the dashboard uses
 * (lib/events/feed.ts), kept here so the two modules stay decoupled.
 */
export function groupPublicEventsByTime(events: PublicEvent[], now: Date): GroupedPublicEvents {
  const cutoff = now.getTime();
  const upcoming: PublicEvent[] = [];
  const past: PublicEvent[] = [];

  for (const e of events) {
    const end = endMs(e);
    if (end !== null && end < cutoff) past.push(e);
    else upcoming.push(e);
  }

  upcoming.sort((a, b) => {
    const sa = startMs(a);
    const sb = startMs(b);
    if (sa === null && sb === null) return 0;
    if (sa === null) return 1; // undated/TBD sinks to the bottom
    if (sb === null) return -1;
    return sa - sb; // soonest first
  });

  past.sort((a, b) => (endMs(b) ?? 0) - (endMs(a) ?? 0)); // newest first

  return { upcoming, past };
}
