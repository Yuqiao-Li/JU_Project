/**
 * Round-4 event "lock" derivation — a pure TS mirror of the DB helper
 * `public.event_is_locked` (migration 0021), shared by the host dashboard UI and
 * unit-testable on its own.
 *
 * KEEP IT PURE. No `server-only`, no DB, no React — it's a plain boolean derivation so
 * both the server detail page and any client component can import it. The DB stays the
 * security boundary: this only decides which lock UI to show. The guest event page does
 * NOT recompute this — it reads `event.is_locked` straight from the RPC payload.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Mirror of public.event_is_locked: locked if manually locked, or within 1 day of start. */
export function isEventLocked(
  lockedAt: string | null,
  startsAt: string | null,
  now = new Date(),
): boolean {
  if (lockedAt) return true;
  if (!startsAt) return false;
  return now.getTime() >= new Date(startsAt).getTime() - ONE_DAY_MS;
}
