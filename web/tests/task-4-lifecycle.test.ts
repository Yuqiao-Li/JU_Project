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
 *                              RSVP behind `!inactive && !locked`, plus a cancelled/ended
 *                              banner AND a locked banner; the FULL address is gated on
 *                              `event.unlocked` (never rendered when locked).
 *   - app/[slug]/event-client.tsx — Step-10A 局卡中心化: the 局卡 (EventCard) is slotted in
 *                              as the hero (cardSlot) with the RsvpForm below (rsvpSlot);
 *                              the guest-list / comments / date-poll slots are NO LONGER
 *                              rendered on this page (PRD 缓做/不做, code retained).
 *   - app/dashboard/events/actions.ts — setEventStatus + deleteEvent exist; updateEvent
 *                              preserves a cancelled status on save (no resurrect, H5).
 *
 * Host-scoping of setEventStatus / deleteEvent is RLS (UPDATE/DELETE USING host_id =
 * auth.uid()) and is already covered by migration-0004-rls — NOT duplicated here. The
 * React client can't be rendered under vitest (server-only + @/-alias make the page
 * un-importable), so the page/view/action invariants are pinned on the SOURCE TEXT — the
 * same static-guard posture the task-4.1 suite uses for its structural invariants.
 *
 * STEP-10A NOTE (局卡中心化 refactor). This suite was rewritten away from brittle JSX
 * source-greps that pinned the OLD event-view layout (e.g. AddToCalendar/pollSlot inside
 * the `!inactive` block, a rendered guestListSlot/commentsSlot). The 局卡 refactor moved
 * the hero to the EventCard and dropped those slots from the page. The assertions below
 * now pin the SECURITY/BEHAVIOR INVARIANTS that must survive ANY layout — RSVP suppressed
 * when inactive OR locked, the right banner shown, the full address unlocked-gated, the
 * card-as-hero + RsvpForm wiring — rather than the exact JSX that happened to encode them.
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

describe("Batch 4 [LIFECYCLE]: event-view suppresses RSVP when inactive/locked, shows the right banner, and unlocked-gates the address (audit B4/H4 · 局卡中心化)", () => {
  const VIEW = src("app/[slug]/event-view.tsx");

  it("derives `inactive` from cancelled OR ended (the one state the dead-event gate keys off)", () => {
    // The exact spelling of the derivation can shift; what matters is BOTH inputs feed it.
    expect(
      /cancelled\s*=\s*event\.status === "cancelled"/.test(VIEW),
      "event-view: cancelled is derived from event.status === 'cancelled'",
    ).toBe(true);
    expect(
      /inactive\s*=[^\n;]*cancelled[^\n;]*\|\|[^\n;]*ended/.test(VIEW),
      "event-view: inactive folds in BOTH cancelled and ended",
    ).toBe(true);
  });

  it("INVARIANT: RSVP is NOT rendered when the event is inactive (cancelled/ended) OR locked", () => {
    // The 局卡 refactor keeps the rsvpSlot, but it must stay behind the !inactive && !locked
    // gate. Pin the INVARIANT (the slot's render is conditioned on both negations) rather than
    // a fixed JSX shape, so a layout move can't quietly expose RSVP on a dead or finalized event.
    expect(VIEW, "event-view still slots in the RSVP interaction").toContain("rsvpSlot");
    expect(
      /!inactive\s*&&\s*!locked\s*&&\s*rsvpSlot/.test(VIEW),
      "event-view: rsvpSlot renders ONLY while !inactive AND !locked (cancelled/ended/locked all close RSVP)",
    ).toBe(true);
    // The slot is never rendered UNGATED: the only standalone-expression render of `rsvpSlot`
    // (i.e. `{ … rsvpSlot}`, not the multi-prop destructuring header) carries the gate. We
    // exclude the param-destructuring block (which legitimately lists the prop name) and check
    // that no remaining single-line `{…rsvpSlot}` container lacks the !inactive && !locked gate.
    const renderSites = (VIEW.match(/^\s*\{[^{}\n]*\brsvpSlot\b[^{}\n]*\}/gm) ?? []).filter(
      (s) => !/:\s*React\.ReactNode/.test(s),
    );
    expect(renderSites.length, "event-view: there is exactly one rsvpSlot render site").toBe(1);
    for (const site of renderSites) {
      expect(
        /!inactive\s*&&\s*!locked/.test(site),
        `event-view: the rsvpSlot render site is gated by !inactive && !locked (offending: ${site})`,
      ).toBe(true);
    }
  });

  it("INVARIANT: a cancelled/ended banner shows when inactive, with text that distinguishes the two states", () => {
    expect(
      /inactive\s*&&/.test(VIEW),
      "event-view: a banner is shown when the event is inactive",
    ).toBe(true);
    expect(
      /cancelled\s*\?\s*t\("cancelledBanner"\)\s*:\s*t\("endedBanner"\)/.test(VIEW),
      "event-view: the banner text picks cancelledBanner vs endedBanner by status",
    ).toBe(true);
  });

  it("INVARIANT: a LOCKED (finalized) event shows the locked banner and is derived as locked-and-still-live", () => {
    // Round-4 / 局卡: a locked-but-not-dead event reads its own banner. `locked` is taken
    // straight from the payload (is_locked) and excludes the inactive case so a cancelled
    // event never reads "locked in" instead of "cancelled".
    expect(
      /locked\s*=\s*event\.is_locked === true\s*&&\s*!inactive/.test(VIEW),
      "event-view: locked = event.is_locked (from the payload) AND !inactive",
    ).toBe(true);
    expect(
      /locked\s*&&/.test(VIEW),
      "event-view: the locked banner is shown when locked",
    ).toBe(true);
    expect(VIEW, "event-view: the locked banner uses the lockedBanner message").toContain(
      't("lockedBanner")',
    );
  });

  it("the cancelled / ended / locked banner messages all exist in the en AND zh catalogs, with the two dead-state banners distinct", () => {
    const en = JSON.parse(src("messages/en.json")).eventPage;
    const zh = JSON.parse(src("messages/zh.json")).eventPage;
    for (const [name, m] of [["en", en], ["zh", zh]] as const) {
      expect(typeof m?.cancelledBanner === "string" && m.cancelledBanner.length > 0, `${name}.cancelledBanner present`).toBe(true);
      expect(typeof m?.endedBanner === "string" && m.endedBanner.length > 0, `${name}.endedBanner present`).toBe(true);
      expect(typeof m?.lockedBanner === "string" && m.lockedBanner.length > 0, `${name}.lockedBanner present`).toBe(true);
      // The two DEAD-state messages must be DISTINCT — a cancelled event and an over event read differently.
      expect(m.cancelledBanner, `${name}: cancelled vs ended banners are distinct`).not.toBe(m.endedBanner);
    }
  });

  it("INVARIANT: the FULL address is gated on event.unlocked — never rendered when the viewer is locked (DESIGN-TONE 未 RSVP 真实地不渲染地址)", () => {
    // The crux of strict tiering at the render layer: fullAddress can ONLY ever be a value
    // when event.unlocked is truthy. If a regression dropped the gate (e.g. read
    // location_text directly), a locked viewer would see the exact address even though the
    // data layer's omission is the real defence — this pins the render gate as a second wall.
    expect(
      /fullAddress\s*=\s*event\.unlocked\s*\?\s*event\.location_text/.test(VIEW),
      "event-view: fullAddress is `event.unlocked ? event.location_text : null`",
    ).toBe(true);
    // The map link rides the same gate (a second-tier field — never shown to a locked viewer).
    expect(
      /mapUrl\s*=\s*event\.unlocked\s*\?\s*event\.location_url/.test(VIEW),
      "event-view: mapUrl is unlocked-gated alongside the address",
    ).toBe(true);
    // The full street text is only ever rendered through the unlocked-derived `fullAddress`,
    // never by reaching for event.location_text again in the JSX.
    const rawLocationReads = VIEW.match(/event\.location_text/g) ?? [];
    expect(
      rawLocationReads.length,
      "event-view: event.location_text is read EXACTLY once — through the unlocked-gated fullAddress",
    ).toBe(1);
  });

  it("局卡中心化: the deferred slots remain OPTIONAL props on event-view (code retained for a future re-mount, PRD 缓做/不做)", () => {
    // The 局卡 refactor drops these slots at the CALL SITE (event-client no longer passes them —
    // pinned in the event-client block below), NOT by deleting event-view's ability to render
    // them. event-view keeps them as OPTIONAL props so re-mounting later is render-only. Pin
    // exactly that: each is an optional `?: React.ReactNode` prop, never a required one.
    for (const slot of ["guestListSlot", "commentsSlot", "pollSlot"]) {
      expect(
        new RegExp(`${slot}\\?:\\s*React\\.ReactNode`).test(VIEW),
        `event-view: ${slot} stays an OPTIONAL prop (retained for a future re-mount)`,
      ).toBe(true);
    }
  });

  it("INVARIANT: the dead-event page stays readable — the guest list / activity feed are NOT hidden behind the inactive gate (B4)", () => {
    // B4 keeps the page useful post-event: whatever reference slots event-view renders must
    // NOT sit inside a !inactive gate, so a cancelled/ended event still shows them for
    // reference. (They render bare; the cardSlot/banner above explains the dead state.)
    expect(
      /!inactive\s*&&\s*guestListSlot/.test(VIEW),
      "event-view: the guest list is NOT hidden on a cancelled/ended event",
    ).toBe(false);
    expect(
      /!inactive\s*&&\s*commentsSlot/.test(VIEW),
      "event-view: the activity feed is NOT hidden on a cancelled/ended event",
    ).toBe(false);
  });
});

describe("Batch 4 [LIFECYCLE] · 局卡中心化: event-client slots the EventCard as hero + RsvpForm below, and keeps the dead-event flag flowing (Step-10A task 4)", () => {
  const CLIENT = src("app/[slug]/event-client.tsx");

  it("the 局卡 (EventCard) is slotted in as the hero via cardSlot", () => {
    expect(CLIENT, "event-client imports the EventCard").toContain("EventCard");
    expect(
      /cardSlot=\{[\s\S]*<EventCard/.test(CLIENT),
      "event-client: <EventCard …/> is passed in as the cardSlot (the 局卡 hero)",
    ).toBe(true);
  });

  it("the RsvpForm is slotted in below as the rsvpSlot", () => {
    expect(CLIENT, "event-client imports the RsvpForm").toContain("RsvpForm");
    expect(
      /rsvpSlot=\{[\s\S]*<RsvpForm/.test(CLIENT),
      "event-client: <RsvpForm …/> is passed in as the rsvpSlot (留位表单 below the card)",
    ).toBe(true);
  });

  it("the dead-event flag still reaches the view — ended is forwarded so the !inactive gate keeps working", () => {
    // event-view's whole inactive gate depends on `ended` arriving. On the SSR path the page
    // computes it; on the password-unlock path event-client derives it. Either way it must be
    // passed to <EventView ended=…/> so a cancelled/ended event still suppresses RSVP.
    expect(CLIENT, "event-client uses isEventEnded for the client-derived fallback").toContain(
      "isEventEnded",
    );
    expect(
      /ended=\{/.test(CLIENT),
      "event-client: an `ended` flag is forwarded to <EventView/>",
    ).toBe(true);
  });

  it("局卡中心化: the deferred guest-list / comments / date-poll slots are NOT passed from event-client either", () => {
    // Belt-and-suspenders with the event-view check: even if a future event-view re-added a
    // render site, event-client must not be wiring these props on the 局详情 page yet.
    for (const slot of ["guestListSlot", "commentsSlot", "pollSlot"]) {
      expect(
        new RegExp(`${slot}=`).test(CLIENT),
        `event-client: ${slot}= is not wired (deferred per 局卡中心化)`,
      ).toBe(false);
    }
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
