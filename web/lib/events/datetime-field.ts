/**
 * Pure, dependency-free helpers for the custom date+time field
 * (`components/events/date-time-field.tsx`). These replace the native
 * `<input type="datetime-local">`, whose displayed format follows the BROWSER's
 * language (not the page `lang`), so a Chinese-browser host saw a mixed
 * "yyyy/mm/日". Here the display format is LOCKED to `yyyy/mm/dd HH:mm` (24h) for
 * everyone; only the calendar chrome localises (done in the component, not here).
 *
 * The contract this module preserves: the field still submits a naive
 * `"YYYY-MM-DDTHH:mm"` string (or "") — byte-identical to what datetime-local
 * sent — so `schema.ts` / `timezone.ts` are untouched. Every transform here is
 * STRING/INT only; the value never passes through a `Date` (that would re-apply
 * the device timezone and corrupt it). `Date` appears once, for calendar-grid
 * math from explicit integer year/month via UTC — never from the value string.
 *
 * Everything is pure and total: bad input returns null / "" rather than throwing.
 */

/** Calendar components of a naive wall-clock value. `mo` is 1-12 (human month). */
export interface DateTimeParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** "19:30" — the default time stamped on a date picked when no time is set yet. */
export const DEFAULT_TIME = "19:30";

/** Zero-pad an integer to `width` digits (assumes non-negative ints). */
function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Naive `"YYYY-MM-DDTHH:mm"` → parts, or null for empty / shape-mismatched input.
 * Parsing is string-only (regex + parseInt); the value never touches `Date`.
 */
export function splitNaive(value: string): DateTimeParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return {
    y: Number.parseInt(m[1], 10),
    mo: Number.parseInt(m[2], 10),
    d: Number.parseInt(m[3], 10),
    h: Number.parseInt(m[4], 10),
    mi: Number.parseInt(m[5], 10),
  };
}

/**
 * Parts → naive `"YYYY-MM-DDTHH:mm"` (zero-padded, no seconds). Assumes valid
 * ints — callers `clampParts` first.
 */
export function joinNaive(parts: DateTimeParts): string {
  return `${pad(parts.y, 4)}-${pad(parts.mo, 2)}-${pad(parts.d, 2)}T${pad(parts.h, 2)}:${pad(parts.mi, 2)}`;
}

/** Naive `"YYYY-MM-DDTHH:mm"` → display `"yyyy/mm/dd HH:mm"`; "" / invalid → "". */
export function naiveToDisplay(value: string): string {
  const p = splitNaive(value);
  if (!p) return "";
  return `${pad(p.y, 4)}/${pad(p.mo, 2)}/${pad(p.d, 2)} ${pad(p.h, 2)}:${pad(p.mi, 2)}`;
}

/**
 * Display `"yyyy/mm/dd HH:mm"` → naive `"YYYY-MM-DDTHH:mm"`. Incomplete or
 * out-of-range input → "" (mirrors native datetime-local, which submits nothing
 * until a full valid value is entered).
 */
export function displayToNaive(display: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(display.trim());
  if (!m) return "";
  const parts: DateTimeParts = {
    y: Number.parseInt(m[1], 10),
    mo: Number.parseInt(m[2], 10),
    d: Number.parseInt(m[3], 10),
    h: Number.parseInt(m[4], 10),
    mi: Number.parseInt(m[5], 10),
  };
  // Reject impossible calendar values (e.g. month 13, day 32, hour 24) without
  // silently clamping — incomplete/invalid yields "", same as the native input.
  if (parts.mo < 1 || parts.mo > 12) return "";
  if (parts.d < 1 || parts.d > daysInMonth(parts.y, parts.mo)) return "";
  if (parts.h > 23 || parts.mi > 59) return "";
  return joinNaive(parts);
}

/**
 * Live input mask: strip every non-digit, then re-insert the fixed separators of
 * `yyyy/mm/dd HH:mm` at their slots, emitting only as many as the typed digits
 * reach (so a partially-typed value reads naturally). String-only.
 */
export function formatMaskedInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 12); // yyyymmddHHmm
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i === 4 || i === 6) out += "/";
    else if (i === 8) out += " ";
    else if (i === 10) out += ":";
    out += digits[i];
  }
  return out;
}

/** Days in a (1-12) month, leap-year aware. Integer arithmetic, no `Date`. */
export function daysInMonth(y: number, mo: number): number {
  if (mo === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 30;
}

/** Clamp parts into valid ranges: mo 1-12, d 1..daysInMonth, h 0-23, mi 0-59. */
export function clampParts(parts: DateTimeParts): DateTimeParts {
  const mo = Math.min(12, Math.max(1, parts.mo));
  const d = Math.min(daysInMonth(parts.y, mo), Math.max(1, parts.d));
  const h = Math.min(23, Math.max(0, parts.h));
  const mi = Math.min(59, Math.max(0, parts.mi));
  return { y: parts.y, mo, d, h, mi };
}

/**
 * A 6×7 (length-42) calendar grid for month `mo` (1-12) of year `y`. Week starts
 * SUNDAY: leading nulls pad the offset to the 1st, then 1..N, then trailing nulls
 * fill to 42. First-weekday offset is the one place `Date` is allowed — computed
 * from explicit integer y/month via UTC so the device timezone can't shift it.
 */
export function buildMonthGrid(y: number, mo: number): (number | null)[] {
  const firstWeekday = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay(); // 0=Sun..6=Sat
  const total = daysInMonth(y, mo);
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= total; day++) cells.push(day);
  while (cells.length < 42) cells.push(null);
  return cells;
}

/** Shift (y, mo) by `delta` months, wrapping the year. `mo` is 1-12 in and out. */
export function addMonths(y: number, mo: number, delta: number): { y: number; mo: number } {
  const zeroBased = (mo - 1) + delta;
  const newY = y + Math.floor(zeroBased / 12);
  const newMo = ((zeroBased % 12) + 12) % 12; // 0-11, always non-negative
  return { y: newY, mo: newMo + 1 };
}
