/**
 * Naive ↔ ISO conversion for the host's date+time input. The host types a
 * wall-clock time ("19:30") in THEIR OWN browser-local time zone; we convert it
 * to the correct absolute UTC instant for storage, and back again for editing.
 *
 * These functions run CLIENT-SIDE ONLY: they rely on the runtime's local time
 * zone (`new Date(y, mo, d, …)` / `Date#getHours`), which on the server is the
 * process tz — NOT the viewer's. The browser is the only place that knows the
 * host's zone, so the naive→UTC conversion must happen there; the server only
 * ever validates an ISO instant (schema.ts), never re-interprets the wall-clock.
 */

/**
 * datetime-local "YYYY-MM-DDTHH:mm" (browser-local wall-clock) → UTC ISO instant,
 * or null for empty / invalid. Built via the local-time `Date` constructor, so in
 * the browser the wall-clock is read in the host's own time zone.
 */
export function localInputToISO(naive: string): string | null {
  const v = naive.trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return null;
  const y = Number.parseInt(m[1], 10);
  const mo = Number.parseInt(m[2], 10);
  const d = Number.parseInt(m[3], 10);
  const h = Number.parseInt(m[4], 10);
  const mi = Number.parseInt(m[5], 10);
  const s = m[6] ? Number.parseInt(m[6], 10) : 0;
  // Local-tz constructor: the host's browser tz turns this wall-clock into the
  // intended absolute instant.
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * UTC ISO instant → "YYYY-MM-DDTHH:mm" in browser-local wall-clock, for the
 * date+time field. "" for null / invalid. Uses local getters, so in the browser
 * the host sees the instant in their own time zone.
 */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
