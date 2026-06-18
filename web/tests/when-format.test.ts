// DETERMINISM: pin the process tz BEFORE importing the module so the runtime-local
// formatters (formatLocal / localDayKey) are deterministic across whatever OS tz the
// runner inherits. America/New_York is EDT (UTC−4) in June, so the keystone 11:30 UTC
// instant is 07:30 local — a value distinct from both the UTC wall-clock (11:30) and the
// removed +08:00 Beijing wall-clock (19:30), which is exactly what §7.4 needs to prove.
process.env.TZ = "America/New_York";

import { describe, expect, it } from "vitest";

import {
  WHEN_OPTIONS,
  END_TIME_OPTIONS,
  COMMENT_OPTIONS,
  formatInUtc,
  formatLocal,
  localDayKey,
  buildLocalTimeScript,
} from "../lib/events/when-format";

/**
 * [WHEN-FORMAT] — black-box tests for the viewer-local DISPLAY core (Round-2 §7.4, Pass A).
 *
 * WHY BLACK BOX: this is the pure spine of the date/time DISPLAY path that replaced the old
 * Beijing-pinned formatters (formatEventWhen / formatEventDay / formatOptionWhen / the old
 * formatCommentTime — all REMOVED). The DB stores every "when" as a UTC instant; the audience
 * is North-American Chinese, so each viewer must see that instant in THEIR OWN browser-local
 * tz and THEIR selected next-intl locale, with a short zone label. vitest runs `node` with no
 * DOM / React, so the client components can't mount — but every byte they render flows through
 * these pure (iso, locale, opts) functions, which are referentially transparent and directly
 * hammerable. (The display HALF of the old task-3-timezone suite moved HERE; that file keeps
 * only the INPUT assertions, which Pass A leaves untouched.)
 *
 * STANCE (adversarial on locale + tz independence — the whole point of §7.4): assume the impl
 * (a) bakes a +08:00 Beijing offset into the formatter (the old behaviour), (b) pins a locale
 * (zh-CN / en-US) instead of honouring the param, (c) lets the server's TZ env leak into the
 * deterministic UTC fallback, or (d) crashes / emits "Invalid Date" on a bad iso. Each is
 * pinned to a literal derived from the WRITTEN CONTRACT so a wrong answer fails LOUDLY.
 *
 * The keystone instant: 11:30:00Z on 2026-06-20. In UTC that's 11:30; in America/New_York
 * (EDT, −4) it's 07:30; the removed Beijing render would have been 19:30 (+8). Those three
 * distinct wall-clocks are what make the assertions discriminating.
 */

// ── The keystone instant: 11:30 UTC = 07:30 America/New_York (EDT) in June 2026.
const Z = "2026-06-20T11:30:00.000Z";

// ─────────────────────────────────────────────────────────────────────────────
// Item 1 — the shared option sets (one per display kind; the per-call fn sets timeZone)
// ─────────────────────────────────────────────────────────────────────────────
describe("[WHEN-FORMAT] option sets: short zone + 24h clock, NO baked timeZone (the renderer supplies UTC or omits it)", () => {
  const ALL = [
    ["WHEN_OPTIONS", WHEN_OPTIONS],
    ["END_TIME_OPTIONS", END_TIME_OPTIONS],
    ["COMMENT_OPTIONS", COMMENT_OPTIONS],
  ] as const;

  it("every option set is short-zone, 24-hour, and carries NO timeZone key (per-call fns pin it)", () => {
    for (const [name, opts] of ALL) {
      expect(opts.timeZoneName, `${name}: short zone label so the wall-clock is never ambiguous`).toBe(
        "short",
      );
      expect(opts.hourCycle, `${name}: 24h clock (h23)`).toBe("h23");
      expect(
        Object.prototype.hasOwnProperty.call(opts, "timeZone"),
        `${name}: NO timeZone key — the renderer supplies UTC (SSR fallback) or omits it (runtime-local)`,
      ).toBe(false);
    }
  });

  it("WHEN_OPTIONS is the full weekday+date+time line", () => {
    expect(WHEN_OPTIONS.weekday, "weekday").toBe("short");
    expect(WHEN_OPTIONS.year, "year").toBe("numeric");
    expect(WHEN_OPTIONS.month, "month").toBe("short");
    expect(WHEN_OPTIONS.day, "day").toBe("numeric");
    expect(WHEN_OPTIONS.hour && WHEN_OPTIONS.minute, "hour+minute").toBeTruthy();
  });

  it("END_TIME_OPTIONS is TIME-ONLY (no year / no day / no month) — the same-local-day range tail", () => {
    expect(END_TIME_OPTIONS.hour && END_TIME_OPTIONS.minute, "carries hour+minute").toBeTruthy();
    expect(END_TIME_OPTIONS.year, "no year").toBeUndefined();
    expect(END_TIME_OPTIONS.day, "no day").toBeUndefined();
    expect(END_TIME_OPTIONS.month, "no month").toBeUndefined();
    expect(END_TIME_OPTIONS.weekday, "no weekday").toBeUndefined();
  });

  it("COMMENT_OPTIONS is month+day+time (no year, no weekday)", () => {
    expect(COMMENT_OPTIONS.month, "month").toBe("short");
    expect(COMMENT_OPTIONS.day, "day").toBe("numeric");
    expect(COMMENT_OPTIONS.hour && COMMENT_OPTIONS.minute, "hour+minute").toBeTruthy();
    expect(COMMENT_OPTIONS.year, "no year on a comment timestamp").toBeUndefined();
    expect(COMMENT_OPTIONS.weekday, "no weekday on a comment timestamp").toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 2 — formatInUtc: the DETERMINISTIC server fallback (pins UTC, honours the locale)
// ─────────────────────────────────────────────────────────────────────────────
describe("[WHEN-FORMAT] formatInUtc: pins UTC (process-tz invariant) and honours the locale PARAM", () => {
  it("the en render carries the UTC wall-clock 11:30 + a zone token, and NEVER the +08:00 (19:30) or local (07:30) hour", () => {
    const out = formatInUtc(Z, "en", WHEN_OPTIONS);
    expect(out, "contains the UTC wall-clock 11:30").toContain("11:30");
    expect(out, "carries a UTC/GMT zone token (timeZoneName: short)").toMatch(/UTC|GMT/);
    expect(out, "NOT the removed +08:00 Beijing hour — no baked offset").not.toContain("19:30");
    expect(out, "NOT the runtime-local NY hour — it pins UTC, not local").not.toContain("07:30");
  });

  it("the zh render carries Chinese 月/日 glyphs and is NOT an English render — the locale is the PARAM, not a pinned zh-CN", () => {
    const zh = formatInUtc(Z, "zh", WHEN_OPTIONS);
    expect(zh, "zh month glyph 月").toContain("月");
    expect(zh, "zh day glyph 日").toContain("日");
    expect(zh, "no English month leaks (locale honoured)").not.toContain("Jun");
    expect(zh, "no English weekday leaks (locale honoured)").not.toContain("Sat");
    // The locale genuinely steers the output: en ≠ zh for the same instant + options.
    expect(zh, "the en and zh outputs DIFFER — locale is honoured, not pinned").not.toBe(
      formatInUtc(Z, "en", WHEN_OPTIONS),
    );
  });

  it("is process-tz invariant — it equals a fresh UTC-pinned Intl formatter, independent of the runner's TZ env", () => {
    const expected = new Intl.DateTimeFormat("en", { ...WHEN_OPTIONS, timeZone: "UTC" }).format(
      Date.parse(Z),
    );
    expect(formatInUtc(Z, "en", WHEN_OPTIONS), "wired straight through to a UTC-pinned formatter").toBe(
      expected,
    );
  });

  it("bad / empty / null / undefined input ⇒ '' (never throws / never 'Invalid Date')", () => {
    expect(formatInUtc("", "en", WHEN_OPTIONS), "empty ⇒ ''").toBe("");
    expect(formatInUtc("not-a-date", "en", WHEN_OPTIONS), "garbage ⇒ ''").toBe("");
    expect(formatInUtc(null as unknown as string, "en", WHEN_OPTIONS), "null ⇒ ''").toBe("");
    expect(formatInUtc(undefined as unknown as string, "en", WHEN_OPTIONS), "undefined ⇒ ''").toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 3 — formatLocal: the RUNTIME-LOCAL render (TZ pinned to America/New_York above)
// ─────────────────────────────────────────────────────────────────────────────
describe("[WHEN-FORMAT] formatLocal: renders in the RUNTIME-LOCAL zone (TZ=America/New_York), not UTC, not Beijing", () => {
  it("carries the NY wall-clock 07:30 + a NY/GMT-4 zone token, and NEVER the UTC hour 11:30", () => {
    const out = formatLocal(Z, "en", WHEN_OPTIONS);
    expect(out, "contains the NY (EDT) wall-clock 07:30").toContain("07:30");
    expect(out, "carries a local zone token (EDT / GMT-4 / EST / GMT-5)").toMatch(/EDT|GMT-4|EST|GMT-5/);
    expect(out, "NOT the UTC hour 11:30 — this is the runtime-local render").not.toContain("11:30");
    expect(out, "NOT the removed Beijing hour 19:30").not.toContain("19:30");
  });

  it("equals a fresh no-timeZone Intl formatter — confirms it omits timeZone and uses the runtime zone", () => {
    const expected = new Intl.DateTimeFormat("en", WHEN_OPTIONS).format(Date.parse(Z));
    expect(formatLocal(Z, "en", WHEN_OPTIONS)).toBe(expected);
  });

  it("bad / empty input ⇒ ''", () => {
    expect(formatLocal("", "en", WHEN_OPTIONS), "empty ⇒ ''").toBe("");
    expect(formatLocal("not-a-date", "en", WHEN_OPTIONS), "garbage ⇒ ''").toBe("");
    expect(formatLocal(null as unknown as string, "en", WHEN_OPTIONS), "null ⇒ ''").toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 4 — localDayKey: en-CA YYYY-MM-DD in the RUNTIME-LOCAL zone (the range-decision key)
// ─────────────────────────────────────────────────────────────────────────────
describe("[WHEN-FORMAT] localDayKey: stable, sortable, locale-independent en-CA YYYY-MM-DD in the runtime-local zone", () => {
  it("the keystone instant's local day is 2026-06-20 (11:30Z is still the 20th in NY)", () => {
    expect(localDayKey(Z)).toBe("2026-06-20");
  });

  it("a late-UTC instant that rolls BACK a day in NY reads as the previous local day (02:00Z ⇒ 22:00 Jun 19 EDT)", () => {
    // 2026-06-20T02:00:00Z is 22:00 on Jun 19 in America/New_York — the local day is the 19th,
    // proving the key is computed in the runtime zone, not from the UTC calendar date.
    expect(localDayKey("2026-06-20T02:00:00.000Z")).toBe("2026-06-19");
  });

  it("bad / empty input ⇒ ''", () => {
    expect(localDayKey(""), "empty ⇒ ''").toBe("");
    expect(localDayKey("not-a-date"), "garbage ⇒ ''").toBe("");
    expect(localDayKey(null as unknown as string), "null ⇒ ''").toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item 5 — buildLocalTimeScript: the inline before-paint hydration script (shape only)
// ─────────────────────────────────────────────────────────────────────────────
describe("[WHEN-FORMAT] buildLocalTimeScript: a defensive inline browser script that rewrites #id to the viewer-local value", () => {
  const ID = "when-abc123";
  const script = buildLocalTimeScript(ID, Z, "zh", WHEN_OPTIONS);

  it("is a non-empty string", () => {
    expect(typeof script).toBe("string");
    expect(script.length, "a real script body").toBeGreaterThan(0);
  });

  it("embeds the element id, the iso, the locale, and the options as JSON literals", () => {
    expect(script, "contains the element id").toContain(ID);
    expect(script, "contains the iso instant").toContain(Z);
    expect(script, "embeds the locale literal").toContain(JSON.stringify("zh"));
    expect(script, "embeds the options object as a JSON literal").toContain(JSON.stringify(WHEN_OPTIONS));
  });

  it("references the browser APIs it needs to rewrite the node's text in the viewer's own zone", () => {
    expect(script, "builds an Intl.DateTimeFormat").toContain("Intl.DateTimeFormat");
    expect(script, "rewrites textContent").toContain("textContent");
    expect(script, "looks the node up by id").toContain("getElementById");
  });

  it("is wrapped defensively in try/catch (a bad iso or missing node never throws on the page)", () => {
    expect(script, "guards with try").toContain("try");
    expect(script, "swallows with catch").toContain("catch");
  });
});
