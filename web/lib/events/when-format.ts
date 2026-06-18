/**
 * Viewer-local date/time formatting (Round-2 §7.4 — DISPLAY path).
 *
 * The DB stores every "when" as a UTC instant. Audience is North-American Chinese,
 * so each viewer must see that instant in THEIR OWN browser-local time zone and in
 * THEIR selected next-intl locale, with a short zone label so the wall-clock is never
 * ambiguous. There is therefore ONE shared option set per kind of display (this also
 * collapses §7.3's zh-CN "yyyy/mm/日" vs en-CA "yyyy/mm/dd" divergence — the locale,
 * not a baked format, is the only knob).
 *
 * Pure + total: no React, no `@/` aliases, no `server-only`, and no `Date.now()` /
 * `new Date()` at module scope — so this is vitest-importable like ./timezone and the
 * formatters are referentially transparent for a given (iso, locale).
 *
 * The SERVER can't know the viewer's tz, so the SSR fallback formats in UTC
 * (`formatInUtc`, deterministic regardless of the server's TZ env) and the browser
 * corrects to local — via the client render on a soft nav, or via an inline script
 * (`buildLocalTimeScript`) before paint on a hard nav. See components/events/local-when.
 */

/**
 * The event "when" line: weekday + date + time + zone, e.g. "Sat, Jun 20, 19:30 GMT+8"
 * / "6月20日周六 19:30 GMT+8". NO `timeZone` key — the renderer supplies UTC (SSR
 * fallback) or omits it (runtime-local).
 */
export const WHEN_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
};

/** The same-local-day range tail: time + zone only, e.g. "22:00 GMT+8". */
export const END_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
};

/** A comment timestamp: month + day + time + zone, e.g. "Jun 17, 15:42 GMT+8". */
export const COMMENT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
};

/** Parse an ISO string to epoch ms, or null when empty/unparseable. */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Format in UTC — the DETERMINISTIC server fallback, independent of the server's TZ
 * env. Pins `timeZone: "UTC"` so SSR is byte-stable; the browser later rewrites this to
 * the viewer-local value. `""` on empty/bad input.
 */
export function formatInUtc(
  iso: string | null | undefined,
  locale: string,
  opts: Intl.DateTimeFormatOptions,
): string {
  const ms = toMs(iso);
  if (ms === null) return "";
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(ms);
}

/**
 * Format in the RUNTIME-LOCAL time zone (no `timeZone` key) — what the viewer's browser
 * actually shows. Matches `buildLocalTimeScript`'s output byte-for-byte. `""` on bad input.
 */
export function formatLocal(
  iso: string | null | undefined,
  locale: string,
  opts: Intl.DateTimeFormatOptions,
): string {
  const ms = toMs(iso);
  if (ms === null) return "";
  return new Intl.DateTimeFormat(locale, opts).format(ms);
}

/**
 * The RUNTIME-LOCAL calendar day as en-CA `YYYY-MM-DD` — the key for the "is the end on
 * the same local day as the start?" range decision. en-CA gives a stable, sortable,
 * locale-independent key. `""` on bad input.
 */
export function localDayKey(iso: string | null | undefined): string {
  const ms = toMs(iso);
  if (ms === null) return "";
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

/**
 * A self-contained inline-script body that rewrites `#elementId`'s textContent to the
 * VIEWER-LOCAL value, before paint, during HTML parsing (the §7.4 hydration contract).
 *
 * Defensive: a `try/catch` swallows any failure (a bad iso, a missing element) and a null
 * guard skips a node that isn't there yet. Every value is embedded as a JSON literal so the
 * script's output is byte-identical to `formatLocal(iso, locale, opts)` — no `timeZone`
 * key, so it formats in the browser's own zone.
 */
export function buildLocalTimeScript(
  elementId: string,
  iso: string,
  locale: string,
  opts: Intl.DateTimeFormatOptions,
): string {
  return (
    `try{var n=document.getElementById(${JSON.stringify(elementId)});` +
    `if(n){n.textContent=new Intl.DateTimeFormat(${JSON.stringify(locale)},` +
    `${JSON.stringify(opts)}).format(new Date(${JSON.stringify(iso)}))}}catch(e){}`
  );
}

/**
 * The "same local day?" decision for a range END is tz-dependent, so the END's label —
 * time-only when it shares the start's local day, full date+time otherwise — must be
 * resolved in the browser. This script computes that decision in the VIEWER's local zone
 * (en-CA day keys, matching `localDayKey`) and rewrites `#elementId`'s textContent to the
 * chosen format, byte-identical to `formatLocal(endIso, locale, sameDay ? endOpts : fullOpts)`.
 * Defensive (`try/catch`, null-guarded); all values embedded as JSON literals.
 */
export function buildLocalRangeEndScript(
  elementId: string,
  startIso: string,
  endIso: string,
  locale: string,
  fullOpts: Intl.DateTimeFormatOptions,
  endOpts: Intl.DateTimeFormatOptions,
): string {
  const dayKeyOpts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  return (
    `try{var n=document.getElementById(${JSON.stringify(elementId)});if(n){` +
    `var k=function(d){return new Intl.DateTimeFormat("en-CA",${JSON.stringify(dayKeyOpts)}).format(d)};` +
    `var s=new Date(${JSON.stringify(startIso)});var e=new Date(${JSON.stringify(endIso)});` +
    `var o=k(s)===k(e)?${JSON.stringify(endOpts)}:${JSON.stringify(fullOpts)};` +
    `n.textContent=new Intl.DateTimeFormat(${JSON.stringify(locale)},o).format(e)` +
    `}}catch(err){}`
  );
}
