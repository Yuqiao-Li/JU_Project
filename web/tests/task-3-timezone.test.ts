// DETERMINISM: pin the process tz BEFORE any import, because localInputToISO /
// isoToLocalInput interpret the naive wall-clock through the RUNTIME-local tz
// (new Date(y,mo,d,…) / Date#getHours). America/New_York is a real DST zone
// (EDT = UTC−4 in summer, EST = UTC−5 in winter), so the same wall-clock maps to
// a DIFFERENT UTC instant by season — which is exactly how we prove the impl uses
// a genuine time zone, not the retired fixed +08:00 Beijing offset. This MUST be
// the first statement in the file.
process.env.TZ = "America/New_York";

import { describe, expect, it } from "vitest";

import { parseEventForm } from "../lib/events/schema";
import { isoToLocalInput, localInputToISO } from "../lib/events/timezone";

/**
 * Round-2 §7.4 Pass B [TIMEZONE] — the INPUT path under the NEW browser-local contract.
 *
 * The launch tz policy changed: there is no longer a fixed Asia/Shanghai (+08:00) read.
 * The host enters a wall-clock in THEIR OWN browser-local zone; the client converts that
 * naive "YYYY-MM-DDTHH:mm" to the correct absolute UTC instant via the local-time Date
 * constructor (so it's DST-aware), and back again for editing. The server (schema.ts) no
 * longer converts — it only VALIDATES an already-UTC ISO instant the client sent.
 *
 * This suite covers the INPUT half only:
 *   1. localInputToISO  — naive browser-local wall-clock → UTC instant (DST-aware).
 *   2. isoToLocalInput  — UTC instant → naive browser-local wall-clock (round-trip).
 *   3. parseEventForm   — now VALIDATES an ISO (rejects a naive value), never re-shifts.
 *
 * The DISPLAY half of this suite (the old Beijing-pinned formatEventWhen / formatEventDay /
 * formatOptionWhen / formatCommentTime) was REMOVED in Pass A; viewer-local display now
 * lives in lib/events/when-format.ts and its replacement coverage in tests/when-format.test.ts.
 * Do NOT re-add display/formatter assertions here.
 *
 * All naive↔ISO assertions below assume the pinned America/New_York runtime:
 *   summer: 2026-06-20 is EDT (UTC−4) ⇒ 19:30 local = 23:30Z same day.
 *   winter: 2026-01-15 is EST (UTC−5) ⇒ 19:30 local = 00:30Z the NEXT day.
 */

// ── The summer keystone instant: 19:30 New-York-local on 2026-06-20 (EDT, UTC−4).
const NY_LOCAL = "2026-06-20T19:30"; // what the host types into datetime-local
const UTC_INSTANT = "2026-06-20T23:30:00.000Z"; // the instant it MEANS (+4 in EDT)
// The retired contract would have read this same wall-clock as Beijing (+08:00):
const RETIRED_BEIJING_INSTANT = "2026-06-20T11:30:00.000Z";

/** Build a minimal create-event FormData (only the fields parseEventForm reads). */
function eventForm(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("title", "t3 tz event");
  fd.set("visibility", "public");
  fd.set("intent", "publish");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

describe("Round-2 §7.4 Pass B [TIMEZONE]: host input is read as browser-local wall-clock and stored as the correct UTC instant (DST-aware)", () => {
  it("localInputToISO('2026-06-20T19:30') === '2026-06-20T23:30:00.000Z' — 19:30 EDT is 23:30 UTC (+4), NOT the naive string and NOT the retired Beijing offset", () => {
    expect(localInputToISO(NY_LOCAL)).toBe(UTC_INSTANT);
    // The output must be a genuine UTC instant 4h AHEAD of the wall-clock in summer —
    // never the naive "19:30" re-stamped as Z (the classic server-tz bug).
    expect(localInputToISO(NY_LOCAL), "must not store the naive wall-clock as UTC").not.toBe(
      "2026-06-20T19:30:00.000Z",
    );
    // Explicitly NOT the old fixed +08:00 Beijing result.
    expect(
      localInputToISO(NY_LOCAL),
      "the retired Asia/Shanghai (+08:00) contract is gone",
    ).not.toBe(RETIRED_BEIJING_INSTANT);
    // Cross-check the offset arithmetically: parsing back, UTC hour is wall-clock + 4.
    const ms = Date.parse(localInputToISO(NY_LOCAL) as string);
    expect(new Date(ms).getUTCHours(), "stored UTC hour = 19 + 4 = 23 (EDT)").toBe(23);
    expect(new Date(ms).getUTCMinutes()).toBe(30);
    expect(new Date(ms).getUTCDate(), "still the 20th in UTC (19:30 + 4h stays same date)").toBe(20);
  });

  it("localInputToISO is a REAL time zone, not a fixed offset — the same wall-clock in WINTER maps to a different UTC instant and crosses the day boundary (EST, UTC−5)", () => {
    // 19:30 on 2026-01-15 is EST (UTC−5) ⇒ 00:30Z on the NEXT day (2026-01-16).
    // A fixed-offset impl would give the same +4 shift year-round and fail this.
    expect(localInputToISO("2026-01-15T19:30")).toBe("2026-01-16T00:30:00.000Z");
  });

  it("localInputToISO rejects empty / whitespace / garbage with null (never a NaN instant, never throws)", () => {
    expect(localInputToISO(""), "empty ⇒ null").toBeNull();
    expect(localInputToISO("   "), "whitespace ⇒ null").toBeNull();
    expect(localInputToISO("not-a-date"), "garbage ⇒ null (no NaN instant)").toBeNull();
  });

  it("isoToLocalInput round-trips the UTC instant back to the SAME New-York wall-clock '2026-06-20T19:30' — the edit form shows what the host typed", () => {
    expect(isoToLocalInput(UTC_INSTANT)).toBe(NY_LOCAL);
    // Round-trip identity holds across DST seasons and a year-end boundary.
    for (const naive of ["2026-06-20T19:30", "2026-01-15T19:30", "2026-12-31T23:59"]) {
      const iso = localInputToISO(naive);
      expect(iso, `${naive} ⇒ a valid instant`).not.toBeNull();
      expect(isoToLocalInput(iso), `round-trip identity for ${naive}`).toBe(naive);
    }
  });

  it("isoToLocalInput returns '' for null / unparseable input (blank field, no crash)", () => {
    expect(isoToLocalInput(null), "null ⇒ empty string").toBe("");
    expect(isoToLocalInput("garbage"), "unparseable ⇒ empty string").toBe("");
  });

  it("parseEventForm VALIDATES an already-UTC ISO and persists it UNCHANGED — it never re-shifts by any offset", () => {
    const res = parseEventForm(
      eventForm({ starts_at: UTC_INSTANT, ends_at: "2026-06-21T02:00:00.000Z" }),
    );
    expect(res.ok, res.ok ? "" : (res as { message: string }).message).toBe(true);
    if (!res.ok) return;
    // Canonical ISO round-trips unchanged — no Beijing/server-tz re-interpretation.
    expect(res.value.input.starts_at, "starts_at persisted as the same canonical UTC instant").toBe(
      UTC_INSTANT,
    );
    expect(res.value.input.ends_at, "ends_at persisted as the same canonical UTC instant").toBe(
      "2026-06-21T02:00:00.000Z",
    );
    expect(res.value.input.date_tbd, "a dated event is not date_tbd").toBe(false);
  });

  it("parseEventForm rejects an UNPARSEABLE start time (no silent mis-store)", () => {
    // Outright garbage / impossible components → Date.parse is NaN → rejected.
    expect(parseEventForm(eventForm({ starts_at: "garbage" })).ok).toBe(false);
    expect(parseEventForm(eventForm({ starts_at: "2026-99-99T99:99" })).ok).toBe(false);
  });

  // The server REJECTS a bare zoneless "YYYY-MM-DDTHH:mm". The client always sends a
  // zoned UTC ISO; a zoneless value means the browser-local→UTC conversion didn't happen
  // (JS off / a bug / a forged POST). Date.parse would otherwise read it as the SERVER's
  // local time and silently mis-store it — the exact server-tz coercion §7.4 forbids — so
  // parseDateTime now requires a trailing Z / ±hh:mm zone. (This flips the earlier
  // KNOWN-GAP test, now that the impl is hardened — caught by the independent test agent.)
  it("parseEventForm REJECTS a zoneless naive value — it must carry a zone (no server-tz coercion)", () => {
    expect(
      parseEventForm(eventForm({ starts_at: NY_LOCAL })).ok,
      "zoneless naive must be rejected, not coerced through the server tz",
    ).toBe(false);
    // …while a proper zoned UTC ISO is accepted and stored unchanged.
    const zoned = parseEventForm(eventForm({ starts_at: UTC_INSTANT }));
    expect(zoned.ok, "a zoned UTC ISO is accepted").toBe(true);
    if (zoned.ok) {
      expect(zoned.value.input.starts_at, "stored unchanged (no re-shift)").toBe(UTC_INSTANT);
    }
  });

  it("parseEventForm with date_tbd ignores any time fields — starts_at/ends_at are null regardless", () => {
    const tbd = parseEventForm(
      eventForm({ date_tbd: "on", starts_at: UTC_INSTANT, ends_at: "2026-06-21T02:00:00.000Z" }),
    );
    expect(tbd.ok && tbd.value.input.date_tbd, "date_tbd=true").toBe(true);
    expect(tbd.ok && tbd.value.input.starts_at, "TBD ⇒ no stored start").toBeNull();
    expect(tbd.ok && tbd.value.input.ends_at, "TBD ⇒ no stored end").toBeNull();
  });

  it("parseEventForm rejects ends_at before starts_at (both valid ISO)", () => {
    const res = parseEventForm(
      eventForm({ starts_at: UTC_INSTANT, ends_at: "2026-06-20T22:00:00.000Z" }),
    );
    expect(res.ok, "end before start is rejected").toBe(false);
  });
});
