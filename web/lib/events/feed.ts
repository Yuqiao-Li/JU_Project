import { z } from "zod";

/**
 * The unified "your events" feed (task 2.3).
 *
 * get_my_events (SECURITY DEFINER, D1) returns a jsonb array of the caller's
 * events — the ones they HOST (host_id) ∪ the ones they ATTEND (guests.user_id) —
 * each tagged role='host' | 'guest'. This module is the boundary: it validates
 * that payload with zod (a forged/garbled response never reaches the view) and
 * shapes it into the upcoming / past groups the dashboard renders. Kept pure so it
 * unit-tests without a database.
 */

export const MY_EVENT_ROLES = ["host", "guest"] as const;
export type MyEventRole = (typeof MY_EVENT_ROLES)[number];

const myEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  cover_image_url: z.string().nullable(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  date_tbd: z.boolean(),
  location_city: z.string().nullable(),
  visibility: z.string(),
  status: z.string(),
  role: z.enum(MY_EVENT_ROLES),
});

export type MyEvent = z.infer<typeof myEventSchema>;

/**
 * Validate the get_my_events jsonb at the boundary. An unexpected shape (null, a
 * string, a row missing fields, an unknown role) collapses to [] rather than
 * throwing — the dashboard degrades to "no events" instead of crashing.
 */
export function parseMyEvents(payload: unknown): MyEvent[] {
  const result = z.array(myEventSchema).safeParse(payload);
  return result.success ? result.data : [];
}

export interface GroupedEvents {
  upcoming: MyEvent[];
  past: MyEvent[];
}

/**
 * The instant an event is "over", in epoch ms — its ends_at, else its starts_at.
 * A date-TBD or fully undated event has no such instant (null): it hasn't happened
 * yet, so it always counts as upcoming. A stale starts_at on a date_tbd event is
 * ignored (the date is being re-decided via the poll).
 */
function endMs(e: MyEvent): number | null {
  if (e.date_tbd) return null;
  const when = e.ends_at ?? e.starts_at;
  if (!when) return null;
  const ms = Date.parse(when);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch ms of the start (for ordering upcoming); null = undated/TBD (sorts last). */
function startMs(e: MyEvent): number | null {
  if (e.date_tbd) return null;
  if (!e.starts_at) return null;
  const ms = Date.parse(e.starts_at);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Split the feed into upcoming vs past around `now`. Upcoming sorts soonest-first
 * with undated/TBD events last; past sorts most-recent-first. An event is past
 * only when it has a concrete end before `now`.
 */
export function groupEventsByTime(events: MyEvent[], now: Date): GroupedEvents {
  const cutoff = now.getTime();
  const upcoming: MyEvent[] = [];
  const past: MyEvent[] = [];

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
