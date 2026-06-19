import { describe, expect, it } from "vitest";

import { isEventLocked } from "../lib/events/lock";

/**
 * Round-4 — pure unit test for `lib/events/lock.ts` `isEventLocked`
 * (Appendix A, final line: "Also unit-test lib/events/lock.ts isEventLocked").
 *
 * This helper is the TS MIRROR of the DB function `public.event_is_locked`
 * (migration 0021): locked === manually locked OR within 1 day of `starts_at`.
 * It only decides which lock UI to show — the DB stays the security boundary —
 * but its derivation must match the SQL exactly so the host dashboard and the
 * server agree. No DB here; we pin the boundary by feeding it explicit `now`s.
 *
 * SQL under mirror:
 *   p_locked_at is not null
 *     or (p_starts_at is not null and now() >= p_starts_at - interval '1 day')
 */
describe("round-4: isEventLocked (mirror of public.event_is_locked)", () => {
  const NOW = new Date("2026-06-18T12:00:00.000Z");
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  it("manual lock wins regardless of start: lockedAt set ⇒ locked, even with no/far start", () => {
    const lockedAt = "2026-01-01T00:00:00.000Z";
    expect(isEventLocked(lockedAt, null, NOW)).toBe(true);
    // A start a full year out is irrelevant once manually locked.
    expect(isEventLocked(lockedAt, "2027-06-18T12:00:00.000Z", NOW)).toBe(true);
  });

  it("no manual lock + null start (date_tbd) ⇒ NOT locked (auto-lock never fires)", () => {
    expect(isEventLocked(null, null, NOW)).toBe(false);
  });

  it("auto-lock derivation: within 24h of start ⇒ locked; outside ⇒ not", () => {
    // Start in 12h (inside the 1-day window) ⇒ locked.
    const inside = new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString();
    expect(isEventLocked(null, inside, NOW)).toBe(true);

    // Start in 2 days (outside the window) ⇒ not locked.
    const outside = new Date(NOW.getTime() + 2 * ONE_DAY_MS).toISOString();
    expect(isEventLocked(null, outside, NOW)).toBe(false);
  });

  it("the boundary is inclusive: now === starts_at - 1 day ⇒ locked (>=, matches SQL)", () => {
    // starts_at exactly one day after now ⇒ now >= starts_at - 1day is an equality ⇒ locked.
    const exactlyOneDayOut = new Date(NOW.getTime() + ONE_DAY_MS).toISOString();
    expect(isEventLocked(null, exactlyOneDayOut, NOW)).toBe(true);

    // One millisecond further out ⇒ now < starts_at - 1day ⇒ not yet locked.
    const justPast = new Date(NOW.getTime() + ONE_DAY_MS + 1).toISOString();
    expect(isEventLocked(null, justPast, NOW)).toBe(false);
  });

  it("a start already in the past ⇒ locked (well inside the window)", () => {
    const past = new Date(NOW.getTime() - 5 * ONE_DAY_MS).toISOString();
    expect(isEventLocked(null, past, NOW)).toBe(true);
  });

  it("defaults `now` to the real clock when omitted (smoke: a long-past start is locked)", () => {
    // No `now` argument — exercises the default param. A start in the distant past
    // must read as locked against the real wall clock.
    expect(isEventLocked(null, "2000-01-01T00:00:00.000Z")).toBe(true);
    // And a manual lock is locked irrespective of the wall clock.
    expect(isEventLocked("2000-01-01T00:00:00.000Z", null)).toBe(true);
  });
});
