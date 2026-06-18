/**
 * Shared event "ended" check (task 2.3). The display-side date/time formatting moved to
 * the viewer-local components (Round-2 §7.4) — see ./when-format + components/events/local-when;
 * a stored UTC instant now reads back in EACH viewer's own browser-local time + locale. This
 * module keeps only the pure instant comparison, which is tz-independent.
 *
 * Display-only concerns never gate the security-bearing fields (full address, guest list);
 * those are gated in the DB.
 */

// A start-but-no-end event is treated as ~6h long before it counts as "ended", so a
// just-started party isn't immediately marked over (audit H3/H4).
const ENDED_GRACE_MS = 6 * 60 * 60 * 1000;

/** Whether the event is over: a concrete end in the past, or a no-end event well past start. */
export function isEventEnded(startsAt: string | null, endsAt: string | null, dateTbd: boolean): boolean {
  if (dateTbd) return false;
  const raw = endsAt ?? startsAt;
  if (!raw) return false;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return false;
  const effectiveEnd = endsAt ? ms : ms + ENDED_GRACE_MS;
  return effectiveEnd < Date.now();
}
