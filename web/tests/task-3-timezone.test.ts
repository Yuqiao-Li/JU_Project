import { describe, expect, it } from "vitest";

import { formatCommentTime } from "../lib/events/comments";
import {
  formatEventDay,
  formatEventWhen,
  formatOptionWhen,
} from "../lib/events/format";
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
// Display: zh-CN pinned to Asia/Shanghai, identical for every viewer / process tz.
// ─────────────────────────────────────────────────────────────────────────────

/** A fresh en-US, Asia/Shanghai formatter — the same instant rendered through it must
 *  DIFFER from the zh-CN output, proving the implementation isn't honouring en-US. */
const EN_US_SH = new Intl.DateTimeFormat("en-US", {
  timeZone: EVENT_TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

describe("Batch 3 [TIMEZONE]: events render in zh-CN pinned to Asia/Shanghai — the Beijing wall-clock, identical regardless of process tz (TEST-SPEC §3)", () => {
  it("formatEventWhen renders the keystone instant as the Beijing wall-clock in zh-CN (6月20日 周六 19:30) — a wrong tz or en-US locale fails this", () => {
    const when = formatEventWhen(UTC_INSTANT, false);
    // The Beijing wall-clock digits + Chinese month/day glyphs must be present.
    expect(when, "contains the Beijing time 19:30").toContain("19:30");
    expect(when, "zh-CN month glyph 月").toContain("月");
    expect(when, "zh-CN day-of-month 20日").toContain("20日");
    expect(when, "zh-CN weekday glyph 周 (Sat = 周六)").toContain("周");
    // It must NOT carry the UTC hour (11:30) — that's the wrong-zone bug.
    expect(when, "never the raw UTC hour 11:30").not.toContain("11:30");
    // And it must NOT equal an en-US render of the same instant (wrong-locale bug).
    expect(when, "render is zh-CN, not en-US").not.toBe(EN_US_SH.format(Date.parse(UTC_INSTANT)));
    expect(when, "no English weekday/month leaks (zh-CN)").not.toMatch(/Sat|Jun/);
  });

  it("formatEventWhen is process-tz invariant — it depends ONLY on the instant, never on the host machine's clock", () => {
    // (We can't re-exec under a different TZ from here, so we prove invariance structurally:
    //  the output equals the zh-CN/Asia-Shanghai render of the instant, which by definition
    //  ignores the process tz — and we already pin those exact glyphs above.)
    const expected = new Intl.DateTimeFormat("zh-CN", {
      timeZone: EVENT_TIME_ZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(Date.parse(UTC_INSTANT));
    expect(formatEventWhen(UTC_INSTANT, false)).toBe(expected);
  });

  it("formatEventWhen / formatEventDay degrade to 'Date TBD' for a TBD or undated event, never an Invalid Date", () => {
    expect(formatEventWhen(null, false)).toBe("Date TBD");
    expect(formatEventWhen(UTC_INSTANT, true), "date_tbd wins over a present start").toBe("Date TBD");
    expect(formatEventWhen("not-a-date", false)).toBe("Date TBD");
    expect(formatEventDay(UTC_INSTANT, false), "day label carries the Beijing date").toContain(
      "20日",
    );
    expect(formatEventDay(null, false)).toBe("Date TBD");
  });

  it("formatCommentTime renders a fixed UTC instant in Beijing time, zh-CN (15:42Z ⇒ 23:42 北京时间), identical on any process tz; bad input ⇒ ''", () => {
    // 2026-06-17T15:42:00Z is 23:42 in Beijing (+8). A device-tz or UTC render would show
    // a different hour; an en-US render would show different glyphs.
    const label = formatCommentTime("2026-06-17T15:42:00Z");
    expect(label, "Beijing wall-clock hour:minute (23:42), not the UTC 15:42").toContain("23:42");
    expect(label, "never the raw UTC time 15:42").not.toContain("15:42");
    expect(label, "zh-CN month glyph").toContain("月");
    expect(label, "Beijing date is the 17th").toContain("17日");
    expect(label, "no English month leaks (zh-CN)").not.toMatch(/Jun/);
    // A pre-midnight-UTC instant that rolls to the NEXT Beijing day: 20:00Z on 06-17 is
    // 04:00 on 06-18 Beijing — the date must advance, proving the zone is really applied.
    expect(formatCommentTime("2026-06-17T20:00:00Z"), "rolls to the next Beijing day").toContain(
      "18日",
    );
    for (const bad of ["", "not-a-date", "2026-13-99", "🛑"]) {
      expect(formatCommentTime(bad), `bad value ${JSON.stringify(bad)} ⇒ ""`).toBe("");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatOptionWhen (M1): include the END DATE only when the end is on another
// Beijing day — so multi-day date-poll candidates read unambiguously.
// ─────────────────────────────────────────────────────────────────────────────

describe("Batch 3 [TIMEZONE]: formatOptionWhen includes the end DATE iff the end is a different Beijing day (M1)", () => {
  it("a same-Beijing-day option shows a bare end TIME (no second date): 19:30 – 22:00", () => {
    // 11:30Z → 14:00Z, both 2026-06-20 in Beijing (19:30 → 22:00).
    const label = formatOptionWhen("2026-06-20T11:30:00Z", "2026-06-20T14:00:00Z");
    expect(label, "start is the Beijing wall-clock").toContain("19:30");
    expect(label, "end is a bare Beijing time").toContain("22:00");
    expect(label, "the two times are joined with a dash").toContain("–");
    // The END must NOT carry a date glyph (no '月' AFTER the dash) on a same-day option.
    const afterDash = label.slice(label.indexOf("–"));
    expect(afterDash, "same-day end is time-only — no second 月/日 date").not.toMatch(/月|日/);
  });

  it("a cross-Beijing-day option INCLUDES the end's date so it reads unambiguously: '… 22:00 – 6月21日…02:00'", () => {
    // 14:00Z (06-20) → 18:00Z (06-20) is 22:00 06-20 → 02:00 06-21 in Beijing — different day.
    const label = formatOptionWhen("2026-06-20T14:00:00Z", "2026-06-20T18:00:00Z");
    expect(label, "start 22:00 Beijing on the 20th").toContain("22:00");
    expect(label, "end 02:00 Beijing").toContain("02:00");
    // The end DATE (the 21st) is now spelled out — the M1 disambiguation.
    expect(label, "the end's Beijing date (21日) is included").toContain("21日");
    const afterDash = label.slice(label.indexOf("–"));
    expect(afterDash, "the post-dash end carries a 月 date glyph (next day)").toContain("月");
  });

  it("formatOptionWhen with no end shows just the start; a bad start ⇒ 'Date TBD' (never Invalid Date)", () => {
    const noEnd = formatOptionWhen("2026-06-20T11:30:00Z", null);
    expect(noEnd, "start only").toContain("19:30");
    expect(noEnd, "no dash when there's no end").not.toContain("–");
    expect(formatOptionWhen("not-a-date", null)).toBe("Date TBD");
    // A bad END is tolerated: fall back to the start-only label, not a crash.
    expect(formatOptionWhen("2026-06-20T11:30:00Z", "garbage"), "bad end ⇒ start-only").toContain(
      "19:30",
    );
  });
});
