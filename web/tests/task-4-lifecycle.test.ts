import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isEventEnded } from "../lib/events/format";

/**
 * Batch 4 [LIFECYCLE] — event cancel / end / delete (audit B4 / H3 / H4 / H5).
 *
 * Written by the INDEPENDENT test agent (this REPLACES the implementer's version) with the
 * stance: "assume a cancelled or finished event still behaves like a LIVE one — guests can
 * still RSVP / vote / add it to their calendar, no banner warns them; OR the public page
 * 404s a cancelled event so guests who hold the link get a dead end; OR a no-end party is
 * marked 'over' the instant it starts (or never); OR a routine content-Save quietly
 * RESURRECTS a cancelled event back to published."
 *
 * No new RPC ships here. The contract lives in:
 *   - lib/events/format.ts  `isEventEnded` — the grace logic (PURE; hammered directly).
 *   - app/[slug]/page.tsx   — the public page hides a DRAFT (404) but renders a CANCELLED
 *                              event read-only; it computes `ended` and passes it down.
 *   - app/[slug]/event-view.tsx — derives `inactive = cancelled || ended` and gates
 *                              RSVP / add-to-calendar / date-poll behind `!inactive`,
 *                              plus a cancelled/ended banner.
 *   - app/dashboard/events/actions.ts — setEventStatus + deleteEvent exist; updateEvent
 *                              preserves a cancelled status on save (no resurrect, H5).
 *
 * Host-scoping of setEventStatus / deleteEvent is RLS (UPDATE/DELETE USING host_id =
 * auth.uid()) and is already covered by migration-0004-rls — NOT duplicated here. The
 * React client can't be rendered under vitest (server-only + @/-alias make the page
 * un-importable), so the page/view/action invariants are pinned on the SOURCE TEXT — the
 * same static-guard posture the task-4.1 suite uses for its structural invariants.
 */

const HOUR = 60 * 60 * 1000;
/** An ISO instant `offsetMs` from now (negative = past). */
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// isEventEnded — the grace logic (audit H3/H4). Pure; no DB, no React.
// ─────────────────────────────────────────────────────────────────────────────

describe("Batch 4 [LIFECYCLE]: isEventEnded grace logic (audit H3/H4)", () => {
  it("a FUTURE event is not ended (concrete end still ahead)", () => {
    expect(isEventEnded(at(24 * HOUR), at(27 * HOUR), false)).toBe(false);
  });

  it("an event whose CONCRETE end is in the past IS ended (the end is authoritative when present)", () => {
    expect(isEventEnded(at(-5 * HOUR), at(-2 * HOUR), false)).toBe(true);
  });

  it("a no-end event JUST after its start is NOT yet ended — the ~6h grace keeps a just-started party live (H3)", () => {
    // Only 1h past start, no end ⇒ still within grace ⇒ not ended. This is the subtle one:
    // without the grace window a party would read 'over' the moment it began.
    expect(isEventEnded(at(-1 * HOUR), null, false)).toBe(false);
    // Even right at the start (0h past) it's not ended.
    expect(isEventEnded(at(-1 * 1000), null, false)).toBe(false);
  });

  it("a no-end event WELL past its start (beyond the ~6h grace) IS ended", () => {
    expect(isEventEnded(at(-8 * HOUR), null, false)).toBe(true);
  });

  it("the concrete end OVERRIDES the grace — a short event with an end 2h ago is ended even though <6h since start", () => {
    // Start 3h ago, end 2h ago: the end is in the past ⇒ ended, regardless of the 6h grace
    // (grace only applies to no-END events). A naive impl that always added grace to the
    // start would wrongly keep this live.
    expect(isEventEnded(at(-3 * HOUR), at(-2 * HOUR), false)).toBe(true);
  });

  it("a date_tbd event is NEVER ended (there's no real time yet), even with past-looking dates", () => {
    expect(isEventEnded(at(-100 * HOUR), at(-90 * HOUR), true)).toBe(false);
    expect(isEventEnded(null, null, true)).toBe(false);
  });

  it("undated / unparseable inputs are not ended (degrade safe, never crash)", () => {
    expect(isEventEnded(null, null, false)).toBe(false);
    expect(isEventEnded("not-a-date", null, false)).toBe(false);
    expect(isEventEnded("not-a-date", "also-bad", false)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Static source guards — the page / view / actions wiring (B4 / H4 / H5).
// ─────────────────────────────────────────────────────────────────────────────

/** Read an implementation source file by repo-relative path (relative to this test). */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

describe("Batch 4 [LIFECYCLE]: the public page hides a DRAFT but renders a CANCELLED event read-only (audit B4)", () => {
  const PAGE = src("app/[slug]/page.tsx");

  it("a DRAFT event still 404s (not public yet)", () => {
    expect(
      /status === "draft"\s*\)\s*notFound\(\)/.test(PAGE),
      "page.tsx: a draft event calls notFound()",
    ).toBe(true);
  });

  it("a CANCELLED event is NEVER 404'd — a guest holding the link must reach the read-only page (B4)", () => {
    // The crux of B4: the page must NOT notFound a cancelled event. If a regression added
    // `if (status === "cancelled") notFound()`, this guard fails.
    expect(
      /status === "cancelled"[\s\S]{0,40}notFound/.test(PAGE),
      "page.tsx: a cancelled event must NOT be sent to notFound()",
    ).toBe(false);
  });

  it("the page computes `ended` via isEventEnded and passes it to the client view (so the view can gate on it)", () => {
    expect(PAGE, "page imports/uses isEventEnded").toContain("isEventEnded");
    expect(
      /ended=\{\s*ended\s*\}/.test(PAGE),
      "page.tsx: the computed `ended` flag is handed to <EventClient />",
    ).toBe(true);
  });
});

describe("Batch 4 [LIFECYCLE]: event-view gates RSVP / calendar / poll behind !inactive and shows a banner (audit B4/H4)", () => {
  const VIEW = src("app/[slug]/event-view.tsx");

  it("derives a single `inactive` state = cancelled || ended (the one gate everything keys off)", () => {
    expect(
      /cancelled\s*=\s*event\.status === "cancelled"/.test(VIEW),
      "event-view: cancelled derived from event.status",
    ).toBe(true);
    expect(
      /inactive\s*=\s*cancelled\s*\|\|\s*ended/.test(VIEW),
      "event-view: inactive = cancelled || ended",
    ).toBe(true);
  });

  it("RSVP is gated behind !inactive && !locked — a cancelled/ended OR locked event renders NO RSVP form", () => {
    expect(
      /\{\s*!inactive\s*&&\s*!locked\s*&&\s*rsvpSlot\s*\}/.test(VIEW),
      "event-view: the rsvpSlot only renders while !inactive AND !locked (round-4: a locked event closes new RSVPs)",
    ).toBe(true);
  });

  it("add-to-calendar AND the date poll are gated behind !inactive (no calendar / no voting on a dead event)", () => {
    // Both live inside the same `{!inactive && ( … <AddToCalendar/> … {pollSlot} … )}` block.
    expect(
      /\{\s*!inactive\s*&&\s*\([\s\S]*AddToCalendar[\s\S]*\)\s*\}/.test(VIEW),
      "event-view: AddToCalendar is inside the !inactive block",
    ).toBe(true);
    expect(
      /\{\s*!inactive\s*&&\s*\([\s\S]*pollSlot[\s\S]*\)\s*\}/.test(VIEW),
      "event-view: the date pollSlot is inside the !inactive block",
    ).toBe(true);
  });

  it("renders a cancelled-or-ended banner whose text distinguishes the two states", () => {
    expect(
      /inactive\s*&&/.test(VIEW),
      "event-view: the banner is shown when inactive",
    ).toBe(true);
    expect(
      /cancelled\s*\?\s*t\("cancelledBanner"\)\s*:\s*t\("endedBanner"\)/.test(VIEW),
      "event-view: banner picks cancelledBanner vs endedBanner by status",
    ).toBe(true);
  });

  it("both banner messages exist in the en AND zh catalogs (no missing-key fallback at runtime)", () => {
    const en = JSON.parse(src("messages/en.json")).eventPage;
    const zh = JSON.parse(src("messages/zh.json")).eventPage;
    for (const [name, m] of [["en", en], ["zh", zh]] as const) {
      expect(typeof m?.cancelledBanner === "string" && m.cancelledBanner.length > 0, `${name}.cancelledBanner present`).toBe(true);
      expect(typeof m?.endedBanner === "string" && m.endedBanner.length > 0, `${name}.endedBanner present`).toBe(true);
      // The two messages must be DISTINCT — a cancelled event and an over event read differently.
      expect(m.cancelledBanner, `${name}: cancelled vs ended banners are distinct`).not.toBe(m.endedBanner);
    }
  });

  it("the guest list + activity feed are NOT gated by inactive (they stay readable for reference after the event)", () => {
    // B4 keeps the page useful post-event: the list/feed render regardless of inactive, so
    // they must NOT sit inside a !inactive gate. (The slots appear bare, not behind !inactive.)
    expect(VIEW, "guestListSlot is rendered").toContain("guestListSlot");
    expect(VIEW, "commentsSlot is rendered").toContain("commentsSlot");
    expect(
      /!inactive\s*&&\s*guestListSlot/.test(VIEW),
      "the guest list is NOT hidden on a cancelled/ended event",
    ).toBe(false);
    expect(
      /!inactive\s*&&\s*commentsSlot/.test(VIEW),
      "the activity feed is NOT hidden on a cancelled/ended event",
    ).toBe(false);
  });
});

describe("Batch 4 [LIFECYCLE]: host lifecycle actions exist, and a content-Save never resurrects a cancelled event (audit H5)", () => {
  const ACTIONS = src("app/dashboard/events/actions.ts");

  it("setEventStatus and deleteEvent server actions are exported", () => {
    expect(
      /export\s+async\s+function\s+setEventStatus\b/.test(ACTIONS),
      "actions.ts: setEventStatus is an exported server action",
    ).toBe(true);
    expect(
      /export\s+async\s+function\s+deleteEvent\b/.test(ACTIONS),
      "actions.ts: deleteEvent is an exported server action",
    ).toBe(true);
  });

  it("the actions module is a server-only ('use server') boundary and re-checks the session before writing", () => {
    expect(/^["']use server["'];?/m.test(ACTIONS), "actions.ts: 'use server' directive").toBe(true);
    // Both lifecycle actions short-circuit when there is no authenticated user.
    expect(
      /auth\.getUser\(\)/.test(ACTIONS),
      "actions.ts: a server-side session check guards the writes (not form-trusted)",
    ).toBe(true);
  });

  it("setEventStatus only ever writes a status from the closed lifecycle set {draft, published, cancelled}", () => {
    expect(
      /LIFECYCLE_STATUSES\s*=\s*\[\s*"draft"\s*,\s*"published"\s*,\s*"cancelled"\s*\]/.test(ACTIONS),
      "actions.ts: the status whitelist is exactly draft/published/cancelled",
    ).toBe(true);
    expect(
      /LIFECYCLE_STATUSES\.includes\(\s*status\s*\)/.test(ACTIONS),
      "actions.ts: setEventStatus rejects any status outside the whitelist",
    ).toBe(true);
  });

  it("updateEvent PRESERVES a cancelled status on save — a content edit cannot publish a cancelled event back to life (H5)", () => {
    // The crux of H5: nextStatus must keep "cancelled" when the existing row is cancelled,
    // and ONLY a draft/published event may follow the publish/draft intent. A regression
    // that derived nextStatus purely from `intent` would resurrect a cancelled event.
    expect(
      /existing\?\.status === "cancelled"\s*\?\s*"cancelled"/.test(ACTIONS),
      "actions.ts: updateEvent keeps a cancelled event cancelled regardless of the save intent",
    ).toBe(true);
    // updateEvent reads the EXISTING status before deciding — proof it doesn't blindly trust intent.
    expect(
      /\.select\("status"\)/.test(ACTIONS),
      "actions.ts: updateEvent reads the current status before computing the next one",
    ).toBe(true);
  });
});
