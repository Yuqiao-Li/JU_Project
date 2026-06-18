import { describe, expect, it } from "vitest";

import {
  splitNaive,
  joinNaive,
  naiveToDisplay,
  displayToNaive,
  formatMaskedInput,
  clampParts,
  daysInMonth,
  buildMonthGrid,
  addMonths,
  DEFAULT_TIME,
  type DateTimeParts,
} from "../lib/events/datetime-field";

/**
 * [DATETIME-FIELD] — black-box tests for the pure core of the custom date+time
 * picker that replaces the native <input type="datetime-local">.
 *
 * WHY BLACK BOX: this module is the data spine of a React picker component. vitest
 * runs in a `node` environment with no DOM and no React renderer, so the *widget*
 * itself can't be mounted here. But every byte the widget submits flows through
 * these pure string/int functions: native value "YYYY-MM-DDTHH:mm"  <->  locked
 * 24h display "yyyy/mm/dd HH:mm"  <->  integer parts. None of these may ever pass a
 * value through a `Date` (the submit value must be byte-identical to what
 * datetime-local would have posted, with zero tz/locale drift), so they are pure
 * and directly hammerable. Every expected value below is derived from the WRITTEN
 * CONTRACT, never from reading the implementation body — a picker that silently
 * corrupts a date on a range/format edge (Feb 30, hour 24, 13-digit overflow) is
 * the exact failure mode these assertions are built to expose.
 *
 * STANCE: assume the picker will (a) accept out-of-range digits and emit a poison
 * canonical string, (b) mis-place mask separators as the user types, (c) clamp to
 * the wrong month length on leap years, or (d) drift the round-trip. Each is pinned
 * to a literal so a wrong answer fails LOUDLY.
 *
 * The single legitimate use of `Date` in this file is in item 9: to INDEPENDENTLY
 * compute the expected Sunday-first weekday offset of a month grid via the same
 * Date.UTC formula the contract names, so that assertion is self-checking.
 */

// ── Item 1: splitNaive — SHAPE-only parse of the canonical naive string.
describe("[DATETIME-FIELD] splitNaive: parses the canonical 'YYYY-MM-DDTHH:mm' by SHAPE only", () => {
  it("splits a well-formed value into 1-12-month integer parts", () => {
    expect(splitNaive("2026-06-20T19:30")).toEqual({
      y: 2026,
      mo: 6,
      d: 20,
      h: 19,
      mi: 30,
    });
  });

  it("returns null for empty and for any SHAPE mismatch (never a partial/NaN parts object)", () => {
    expect(splitNaive("")).toBeNull();
    expect(splitNaive("2026-06-20 19:30"), "space instead of 'T' separator").toBeNull();
    expect(splitNaive("2026/06/20T19:30"), "slashes are the display form, not naive").toBeNull();
    expect(splitNaive("2026-6-2T9:3"), "not zero-padded").toBeNull();
    expect(splitNaive("2026-06-20T19:30:00"), "carries seconds — wrong shape").toBeNull();
    expect(splitNaive("garbage")).toBeNull();
  });

  it("is SHAPE-only: it does NOT range-validate, so out-of-range digits still split (split=shape, clamp/displayToNaive=ranges)", () => {
    // This is the contract's deliberate split of responsibility — assert it explicitly.
    expect(splitNaive("2026-13-40T25:99")).toEqual({
      y: 2026,
      mo: 13,
      d: 40,
      h: 25,
      mi: 99,
    });
  });
});

// ── Item 2: joinNaive — zero-padding back to the canonical string.
describe("[DATETIME-FIELD] joinNaive: zero-pads parts back to the canonical naive string", () => {
  it("zero-pads single-digit month/day/hour/minute", () => {
    expect(joinNaive({ y: 2026, mo: 1, d: 5, h: 9, mi: 0 })).toBe("2026-01-05T09:00");
  });

  it("leaves two-digit fields intact at the upper edge", () => {
    expect(joinNaive({ y: 2026, mo: 12, d: 31, h: 23, mi: 59 })).toBe("2026-12-31T23:59");
  });
});

// ── Item 3: naiveToDisplay — canonical -> locked 24h display.
describe("[DATETIME-FIELD] naiveToDisplay: 'YYYY-MM-DDTHH:mm' -> 'yyyy/mm/dd HH:mm'", () => {
  it("converts a valid value to the slash/space 24h display", () => {
    expect(naiveToDisplay("2026-06-20T19:30")).toBe("2026/06/20 19:30");
  });

  it("preserves zero-padding in the display", () => {
    expect(naiveToDisplay("2026-01-05T09:00")).toBe("2026/01/05 09:00");
  });

  it("returns '' for empty and for malformed input (blank field, never 'Invalid')", () => {
    expect(naiveToDisplay("")).toBe("");
    expect(naiveToDisplay("garbage")).toBe("");
    expect(naiveToDisplay("2026-06-20 19:30"), "wrong shape -> ''").toBe("");
  });
});

// ── Item 4: displayToNaive — display -> canonical, WITH range validation. (ADVERSARIAL)
describe("[DATETIME-FIELD] displayToNaive: 'yyyy/mm/dd HH:mm' -> canonical, rejecting out-of-range as '' (ADVERSARIAL)", () => {
  it("converts a valid display string and trims surrounding whitespace", () => {
    expect(displayToNaive("2026/06/20 19:30")).toBe("2026-06-20T19:30");
    expect(displayToNaive("  2026/06/20 19:30  "), "trims surrounding whitespace").toBe(
      "2026-06-20T19:30",
    );
  });

  it("returns '' for incomplete input and wrong separators", () => {
    expect(displayToNaive("2026/06/"), "incomplete").toBe("");
    expect(displayToNaive("2026/06/20 19"), "missing minutes").toBe("");
    expect(displayToNaive("2026-06-20 19:30"), "dashes are the naive form, not display").toBe("");
  });

  it("rejects well-formed-but-OUT-OF-RANGE values — the data-corruption edges", () => {
    expect(displayToNaive("2026/13/01 12:00"), "month 13").toBe("");
    expect(displayToNaive("2026/01/32 12:00"), "day 32").toBe("");
    expect(displayToNaive("2026/02/30 12:00"), "Feb 30 — 2026 Feb has 28 days").toBe("");
    expect(displayToNaive("2026/01/01 24:00"), "hour 24").toBe("");
    expect(displayToNaive("2026/01/01 12:60"), "minute 60").toBe("");
  });

  it("accepts a VALID leap day (2024 is a leap year, so Feb 29 exists)", () => {
    expect(displayToNaive("2024/02/29 00:00")).toBe("2024-02-29T00:00");
  });
});

// ── Item 5: Round-trip identity across the display boundary.
describe("[DATETIME-FIELD] round-trip identity: displayToNaive(naiveToDisplay(s)) === s for valid canonical strings", () => {
  it.each([
    "2026-01-05T09:00",
    "2024-02-29T00:00",
    "2026-12-31T23:59",
    "2026-06-20T19:30",
  ])("round-trips %s losslessly (no drift through the display form)", (s) => {
    expect(displayToNaive(naiveToDisplay(s))).toBe(s);
  });
});

// ── Item 6: formatMaskedInput — live mask: strip non-digits, fixed-slot separators. (ADVERSARIAL)
describe("[DATETIME-FIELD] formatMaskedInput: re-masks raw keystrokes into 'yyyy/mm/dd HH:mm' at fixed slots (ADVERSARIAL)", () => {
  it("inserts separators for full and date-only digit runs", () => {
    expect(formatMaskedInput("20260620")).toBe("2026/06/20");
    expect(formatMaskedInput("202606201930")).toBe("2026/06/20 19:30");
  });

  it("emits only as far as typed (partial inputs reveal separators exactly at the boundary)", () => {
    expect(formatMaskedInput("2026")).toBe("2026");
    expect(formatMaskedInput("20260")).toBe("2026/0");
    expect(formatMaskedInput("2026062")).toBe("2026/06/2");
    expect(formatMaskedInput("2026062019")).toBe("2026/06/20 19");
  });

  it("strips all non-digit junk before re-masking (already-separated and leading-letters)", () => {
    expect(formatMaskedInput("2026/06/20 19:30"), "already separated -> stable").toBe(
      "2026/06/20 19:30",
    );
    expect(formatMaskedInput("abc2026"), "leading letters stripped").toBe("2026");
  });

  it("caps at 12 digits — extra trailing digits are dropped (no overflow into a 13th slot)", () => {
    expect(formatMaskedInput("2026062019305555")).toBe("2026/06/20 19:30");
  });
});

// ── Item 7: daysInMonth — Gregorian month lengths incl. century leap rule.
describe("[DATETIME-FIELD] daysInMonth: Gregorian lengths including the century leap-year rule", () => {
  it("returns the right length for fixed-length months", () => {
    expect(daysInMonth(2026, 1), "Jan").toBe(31);
    expect(daysInMonth(2026, 4), "Apr").toBe(30);
    expect(daysInMonth(2026, 12), "Dec").toBe(31);
  });

  it("applies the full leap rule to February (4 / 100 / 400)", () => {
    expect(daysInMonth(2026, 2), "common year").toBe(28);
    expect(daysInMonth(2024, 2), "÷4 leap").toBe(29);
    expect(daysInMonth(2000, 2), "÷400 leap").toBe(29);
    expect(daysInMonth(1900, 2), "÷100 not ÷400 — NOT a leap year").toBe(28);
  });
});

// ── Item 8: clampParts — coerce out-of-range parts into valid ranges. (ADVERSARIAL)
describe("[DATETIME-FIELD] clampParts: coerces each out-of-range field into the valid range (ADVERSARIAL)", () => {
  it("clamps month to 1..12", () => {
    expect(clampParts({ y: 2026, mo: 13, d: 1, h: 0, mi: 0 }).mo, "13 -> 12").toBe(12);
    expect(clampParts({ y: 2026, mo: 0, d: 1, h: 0, mi: 0 }).mo, "0 -> 1").toBe(1);
  });

  it("clamps the day to the TARGET month's true length (leap-aware)", () => {
    expect(clampParts({ y: 2026, mo: 1, d: 32, h: 0, mi: 0 }).d, "Jan 32 -> 31").toBe(31);
    expect(clampParts({ y: 2026, mo: 2, d: 30, h: 0, mi: 0 }).d, "Feb 30 in 2026 -> 28").toBe(28);
    expect(clampParts({ y: 2024, mo: 2, d: 30, h: 0, mi: 0 }).d, "Feb 30 in 2024 (leap) -> 29").toBe(
      29,
    );
  });

  it("clamps hour to 0..23 and minute to 0..59", () => {
    expect(clampParts({ y: 2026, mo: 1, d: 1, h: 24, mi: 0 }).h, "hour 24 -> 23").toBe(23);
    expect(clampParts({ y: 2026, mo: 1, d: 1, h: -1, mi: 0 }).h, "hour -1 -> 0").toBe(0);
    expect(clampParts({ y: 2026, mo: 1, d: 1, h: 0, mi: 60 }).mi, "minute 60 -> 59").toBe(59);
    expect(clampParts({ y: 2026, mo: 1, d: 1, h: 0, mi: -5 }).mi, "minute -5 -> 0").toBe(0);
  });

  it("returns a fully-valid parts object UNCHANGED", () => {
    const valid: DateTimeParts = { y: 2026, mo: 6, d: 20, h: 19, mi: 30 };
    expect(clampParts(valid)).toEqual(valid);
  });
});

// ── Item 9: buildMonthGrid — 42-cell Sunday-first calendar grid.
describe("[DATETIME-FIELD] buildMonthGrid: 42-cell Sunday-first grid, leading nulls + 1..N contiguous + trailing nulls", () => {
  // Self-checking expected offset, computed via the SAME UTC formula the contract names.
  const expectedOffset = (y: number, mo: number) => new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();

  // Pick a month starting mid-week and one starting on Sunday so the offset matters.
  // (We don't hardcode the offset — we derive it independently below, then assert it.)
  it.each([
    [2026, 3], // March 2026
    [2026, 11], // November 2026
    [2026, 2], // February 2026 (28 days)
    [2024, 2], // February 2024 (leap, 29 days)
  ])("for %i/%i: length 42, contiguous 1..N, and a self-checked Sunday-first offset", (y, mo) => {
    const grid = buildMonthGrid(y, mo);
    const N = daysInMonth(y, mo);

    expect(grid.length, "always exactly 6 weeks x 7 days = 42 cells").toBe(42);

    const nonNull = grid.filter((c): c is number => c !== null);
    expect(nonNull.length, "exactly daysInMonth non-null cells").toBe(N);
    expect(nonNull, "the day numbers appear in order 1..N").toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );

    const firstNonNullIndex = grid.findIndex((c) => c !== null);
    expect(
      firstNonNullIndex,
      "the leading-null offset equals the Sunday-first UTC weekday of day 1",
    ).toBe(expectedOffset(y, mo));

    // The non-null block is a single contiguous run (no gaps) — null...numbers...null.
    const lastNonNullIndex = grid.lastIndexOf(nonNull[nonNull.length - 1]);
    expect(
      lastNonNullIndex - firstNonNullIndex + 1,
      "the day cells form one contiguous block",
    ).toBe(N);
  });

  it("includes at least one mid-week-start month and one Sunday-start month among our picks (offset varies)", () => {
    // Self-evidence that the offset assertion above is actually exercising both shapes.
    const offsets = [
      expectedOffset(2026, 3),
      expectedOffset(2026, 11),
      expectedOffset(2026, 2),
      expectedOffset(2024, 2),
    ];
    expect(offsets.some((o) => o === 0), "some month starts on Sunday (offset 0)").toBe(true);
    expect(offsets.some((o) => o > 0), "some month starts mid-week (offset > 0)").toBe(true);
  });
});

// ── Item 10: addMonths — month arithmetic with year carry/borrow.
describe("[DATETIME-FIELD] addMonths: month-delta navigation carrying/borrowing across year boundaries", () => {
  it("steps back across the year boundary", () => {
    expect(addMonths(2026, 1, -1)).toEqual({ y: 2025, mo: 12 });
  });

  it("steps forward across the year boundary", () => {
    expect(addMonths(2026, 12, 1)).toEqual({ y: 2027, mo: 1 });
  });

  it("a zero delta is the identity", () => {
    expect(addMonths(2026, 6, 0)).toEqual({ y: 2026, mo: 6 });
  });

  it("carries multiple years forward and borrows multiple months back", () => {
    expect(addMonths(2026, 1, 13)).toEqual({ y: 2027, mo: 2 });
    expect(addMonths(2026, 3, -5)).toEqual({ y: 2025, mo: 10 });
  });
});

// ── Item 11: DEFAULT_TIME constant.
describe("[DATETIME-FIELD] DEFAULT_TIME: the picker's default wall-clock", () => {
  it("is exactly '19:30'", () => {
    expect(DEFAULT_TIME).toBe("19:30");
  });
});
