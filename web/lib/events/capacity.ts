/**
 * Capacity + waitlist presentation (task 3.2) — the single, pure source of the public
 * page's "X spots left / Full — join the waitlist" line and the host page's
 * remaining-seat math.
 *
 * Capacity is the DATABASE's authority, never these helpers: submit_rsvp decides going
 * vs. waitlisted, and promote_guest moves a waitlisted guest only if a seat fits — both
 * under the same per-event advisory lock (D7①). These functions only PRESENT the
 * already-decided numbers, so they never gate a write.
 *
 * Kept pure (no `server-only`, no DB, no React) so it unit-tests without a database and
 * is shared by the public façade view and the host dashboard — one tested source for
 * the copy, never two ad-hoc strings that can drift apart.
 */

interface OccupancyRow {
  status: string;
  plus_ones: number | null;
}

/**
 * Heads occupying a seat: each GOING rsvp counts itself plus its +1s. maybe / not_going /
 * waitlisted hold no seat. A negative/null +1 floors to 0, so occupancy is never less
 * than the lone head — mirrors going_count's accounting (D7①).
 */
export function goingOccupancy(rows: OccupancyRow[]): number {
  return rows.reduce(
    (sum, r) => (r.status === "going" ? sum + 1 + Math.max(0, r.plus_ones ?? 0) : sum),
    0,
  );
}

/**
 * Seats still open: null when there is no capacity limit (nothing to show), otherwise
 * the cap minus occupancy clamped to a non-negative integer — a host who shrank the cap
 * below the headcount still never sees a negative count.
 */
export function remainingSpots(
  capacity: number | null | undefined,
  goingCount: number,
): number | null {
  if (capacity == null) return null;
  return Math.max(0, capacity - goingCount);
}

/**
 * The public capacity line (还剩 X 位 / 已满—等待名单). null when unbounded (no chip);
 * "Full — join the waitlist" once no seats remain; otherwise the exact singular/plural
 * "N spot(s) left". The waitlist framing matches the RSVP form's "Join waitlist" wording
 * so the action keeps one name end-to-end.
 */
export function spotsLeftLabel(remaining: number | null | undefined): string | null {
  if (remaining == null) return null;
  if (remaining <= 0) return "Full — join the waitlist";
  return `${remaining} ${remaining === 1 ? "spot" : "spots"} left`;
}
