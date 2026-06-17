import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isEventEnded } from "../lib/events/format";

/**
 * Task 4 — event lifecycle (audit B4/H3/H4/H5/H8). No new RPC; this pins:
 *  - isEventEnded's grace logic (a just-started no-end event isn't "ended" yet);
 *  - the public page renders a CANCELLED event read-only (banner, NO RSVP) instead
 *    of as a live, RSVP-able event (B4), and gates RSVP/voting/calendar when
 *    cancelled OR ended.
 * Host-scoping of the cancel/delete actions is RLS on events (UPDATE/DELETE USING
 * host_id = auth.uid()), already covered by migration-0004-rls.
 */

const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("isEventEnded (audit H3/H4)", () => {
  it("a future event is not ended", () => {
    expect(isEventEnded(iso(24 * HOUR), iso(27 * HOUR), false)).toBe(false);
  });
  it("an event whose concrete end is in the past is ended", () => {
    expect(isEventEnded(iso(-5 * HOUR), iso(-2 * HOUR), false)).toBe(true);
  });
  it("a no-end event just after its start is NOT yet ended (grace window)", () => {
    expect(isEventEnded(iso(-1 * HOUR), null, false)).toBe(false);
  });
  it("a no-end event well past its start (beyond grace) is ended", () => {
    expect(isEventEnded(iso(-8 * HOUR), null, false)).toBe(true);
  });
  it("a date-TBD event is never ended", () => {
    expect(isEventEnded(iso(-100 * HOUR), iso(-90 * HOUR), true)).toBe(false);
  });
  it("undated / unparseable inputs are not ended", () => {
    expect(isEventEnded(null, null, false)).toBe(false);
    expect(isEventEnded("not-a-date", null, false)).toBe(false);
  });
});

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

describe("public page renders cancelled/ended read-only, never as a live RSVP (audit B4)", () => {
  const PAGE = src("app/[slug]/page.tsx");
  const VIEW = src("app/[slug]/event-view.tsx");

  it("the page hides drafts but does NOT notFound a cancelled event", () => {
    expect(/status === "draft"\s*\)\s*notFound\(\)/.test(PAGE), "draft still 404s").toBe(true);
    expect(/status === "cancelled"\s*\)\s*notFound/.test(PAGE), "cancelled must NOT be 404'd").toBe(false);
  });

  it("the page computes `ended` and passes it to the client", () => {
    expect(PAGE).toContain("isEventEnded");
    expect(/ended=\{ended\}/.test(PAGE)).toBe(true);
  });

  it("event-view derives an `inactive` (cancelled || ended) state", () => {
    expect(/cancelled = event\.status === "cancelled"/.test(VIEW)).toBe(true);
    expect(/inactive = cancelled \|\| ended/.test(VIEW)).toBe(true);
  });

  it("event-view gates RSVP, voting and add-to-calendar behind !inactive", () => {
    expect(/\{!inactive && rsvpSlot\}/.test(VIEW), "RSVP gated").toBe(true);
    expect(/!inactive &&[\s\S]*AddToCalendar/.test(VIEW), "calendar + poll gated").toBe(true);
  });

  it("event-view shows a cancelled/ended banner", () => {
    expect(/cancelled \? t\("cancelledBanner"\) : t\("endedBanner"\)/.test(VIEW)).toBe(true);
    const zh = JSON.parse(src("messages/zh.json")).eventPage;
    const en = JSON.parse(src("messages/en.json")).eventPage;
    expect(zh.cancelledBanner && zh.endedBanner, "zh banner messages exist").toBeTruthy();
    expect(en.cancelledBanner && en.endedBanner, "en banner messages exist").toBeTruthy();
  });
});
