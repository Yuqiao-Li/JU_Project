import { describe, expect, it } from "vitest";

import { parseEventForm } from "../lib/events/schema";
import {
  EVENT_TIME_ZONE,
  isoToLocalInput,
  localInputToISO,
} from "../lib/events/timezone";

/**
 * Batch 3 [TIMEZONE] — the launch time-zone policy (TEST-SPEC §3, currently UNTESTED).
 *
 * Written by the INDEPENDENT test agent with the stance: "assume the app silently treats
 * a host's `datetime-local` input as the SERVER's local time (or as a naive/UTC string),
 * stores the wrong instant, and/or renders back in the viewer's device tz or an en-US
 * locale — so '19:30' drifts by the server's offset and a Beijing host's 7:30pm party
 * shows as some other hour to a guest abroad."
 *
 * The contract (lib/events/timezone.ts header; CLAUDE.md tz policy): every host enters
 * AND every viewer sees Asia/Shanghai wall-clock (a fixed +08:00, no DST), regardless of
 * the process/device tz. The host's `datetime-local` "YYYY-MM-DDTHH:mm" is READ as Beijing
 * wall-clock, PERSISTED as the correct UTC instant, and DISPLAYED back in zh-CN pinned to
 * Asia/Shanghai. These are pure functions (no DB, no React), so they're hammered directly.
 *
 * The keystone anchor instant: 19:30 Beijing on 2026-06-20 IS 11:30:00Z (19:30 − 08:00).
 * Every assertion below is pinned to that exact instant so a wrong offset (e.g. storing the
 * naive string, or applying the runner's local tz) fails LOUDLY, not by a fuzzy margin.
 *
 * ADVERSARIAL ROBUSTNESS: the rendering assertions must hold no matter what TZ env the
 * process runs under (vitest's node env inherits the OS tz). We therefore (a) pin the
 * literal Beijing wall-clock these formatters must produce, and (b) cross-check the SAME
 * instant against a freshly-built en-US / device-tz formatter to prove the implementation
 * is NOT accidentally honouring those — a wrong locale or zone diverges from the pin.
 */

// ── The keystone instant: 19:30 北京时间 on 2026-06-20.
const BEIJING_LOCAL = "2026-06-20T19:30"; // what the host types into datetime-local
const UTC_INSTANT = "2026-06-20T11:30:00.000Z"; // the correct instant it MEANS (−08:00)

/** Build a minimal create-event FormData (only the fields parseEventForm reads). */
function eventForm(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("title", "t3 tz event");
  fd.set("visibility", "public");
  fd.set("intent", "publish");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

describe("Batch 3 [TIMEZONE]: datetime-local is read as Beijing wall-clock and stored as the correct UTC instant (TEST-SPEC §3)", () => {
  it("the single source of truth is Asia/Shanghai (a wrong/empty zone would mis-render everything downstream)", () => {
    expect(EVENT_TIME_ZONE, "the launch zone is Asia/Shanghai (+08:00, no DST)").toBe(
      "Asia/Shanghai",
    );
  });

  it("localInputToISO('2026-06-20T19:30') === '2026-06-20T11:30:00.000Z' — 19:30 Beijing is 11:30 UTC, NOT the naive string and NOT the server's local offset", () => {
    expect(localInputToISO(BEIJING_LOCAL)).toBe(UTC_INSTANT);
    // The output must be a genuine UTC instant 8h behind the wall-clock — never the naive
    // "19:30" re-stamped as Z (that would be the classic server-tz bug).
    expect(localInputToISO(BEIJING_LOCAL), "must not store the naive wall-clock as UTC").not.toBe(
      "2026-06-20T19:30:00.000Z",
    );
    // Cross-check the offset arithmetically: parsing back, UTC hour is wall-clock − 8.
    const ms = Date.parse(localInputToISO(BEIJING_LOCAL) as string);
    expect(new Date(ms).getUTCHours(), "stored UTC hour = 19 − 8 = 11").toBe(11);
    expect(new Date(ms).getUTCMinutes()).toBe(30);
    expect(new Date(ms).getUTCDate(), "still the 20th in UTC (19:30 − 8h stays same date)").toBe(20);
  });

  it("localInputToISO accepts a seconds-bearing input and rejects garbage (null), never throwing", () => {
    // A value already carrying :ss is normalised, not double-suffixed.
    expect(localInputToISO("2026-06-20T19:30:45")).toBe("2026-06-20T11:30:45.000Z");
    expect(localInputToISO(""), "empty ⇒ null").toBeNull();
    expect(localInputToISO("   "), "whitespace ⇒ null").toBeNull();
    expect(localInputToISO("not-a-date"), "garbage ⇒ null (no NaN instant)").toBeNull();
  });

  it("isoToLocalInput round-trips the UTC instant back to the SAME Beijing wall-clock '2026-06-20T19:30' — the edit form shows what the host typed, on any process tz", () => {
    expect(isoToLocalInput(UTC_INSTANT)).toBe(BEIJING_LOCAL);
    // Full round-trip in both directions is the identity for a wall-clock value.
    expect(isoToLocalInput(localInputToISO(BEIJING_LOCAL))).toBe(BEIJING_LOCAL);
    expect(localInputToISO(isoToLocalInput(UTC_INSTANT))).toBe(UTC_INSTANT);
  });

  it("isoToLocalInput crosses the UTC day boundary correctly — a late-evening Beijing instant whose UTC date is the PREVIOUS day still reads as the Beijing wall-clock", () => {
    // 00:30 Beijing on 2026-06-21 is 16:30Z on 2026-06-20 (UTC date is a day earlier).
    // A naive (server-tz) reader would slip the date; the Beijing reader must not.
    expect(isoToLocalInput("2026-06-20T16:30:00.000Z")).toBe("2026-06-21T00:30");
    expect(isoToLocalInput(null), "null ⇒ empty string (blank field, no crash)").toBe("");
    expect(isoToLocalInput("bad"), "unparseable ⇒ empty string").toBe("");
  });

  it("parseEventForm stores starts_at/ends_at as the +08:00→UTC instant — NOT the naive datetime-local string, NOT the runner's local-tz interpretation", () => {
    const res = parseEventForm(eventForm({ starts_at: BEIJING_LOCAL, ends_at: "2026-06-20T22:00" }));
    expect(res.ok, res.ok ? "" : (res as { message: string }).message).toBe(true);
    if (!res.ok) return;
    expect(res.value.input.starts_at, "starts_at persisted as the Beijing→UTC instant").toBe(
      UTC_INSTANT,
    );
    expect(res.value.input.starts_at, "the naive wall-clock is never persisted").not.toBe(
      `${BEIJING_LOCAL}:00.000Z`,
    );
    expect(res.value.input.ends_at, "ends_at persisted as 22:00 Beijing = 14:00 UTC").toBe(
      "2026-06-20T14:00:00.000Z",
    );
    expect(res.value.input.date_tbd, "a dated event is not date_tbd").toBe(false);
  });

  it("parseEventForm with date_tbd ignores any times, and a malformed start time is rejected (no silent mis-store)", () => {
    const tbd = parseEventForm(eventForm({ date_tbd: "on", starts_at: BEIJING_LOCAL }));
    expect(tbd.ok && tbd.value.input.date_tbd, "date_tbd=true").toBe(true);
    expect(tbd.ok && tbd.value.input.starts_at, "TBD ⇒ no stored start").toBeNull();

    const bad = parseEventForm(eventForm({ starts_at: "2026-99-99T99:99" }));
    expect(bad.ok, "an unparseable start time is rejected, never coerced into a wrong instant").toBe(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: the DISPLAY half of this suite — the old, Beijing-pinned formatEventWhen /
// formatEventDay / formatOptionWhen / formatCommentTime — was REMOVED in Round-2 §7.4
// (Pass A). Display now goes through the viewer-local pure module lib/events/when-format.ts
// (+ client components), so those formatters no longer exist. Their replacement coverage
// lives in tests/when-format.test.ts. What REMAINS above is the INPUT path
// (localInputToISO / isoToLocalInput / EVENT_TIME_ZONE / parseEventForm), which Pass A
// leaves UNCHANGED (still the +08:00 Beijing read) — Pass B revisits it later.
// ─────────────────────────────────────────────────────────────────────────────
