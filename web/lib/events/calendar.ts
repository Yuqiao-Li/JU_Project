import type { EventView } from "./view";

/**
 * "Add to calendar" builders (task 2.6) — a Google Calendar template URL and an
 * RFC 5545 (.ics) document, both derived purely from the tiered event façade.
 *
 * No `server-only`, no DB, no network: a guest adds an event to their own calendar
 * entirely client-side. The whole feature inherits the data layer's tiering for free —
 * the façade only ever carries the full address (`location_text`) once unlocked, so a
 * locked viewer can only ever produce the city. We never reach for `contact` (the
 * façade has none — 不依赖 contact) and never synthesise an address that wasn't returned.
 */

/** Two hours, the sensible default span when an event has no explicit end. */
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

/** The calendar-relevant slice of an event, dates resolved to concrete instants. */
export interface CalendarSource {
  /** Stable identifier for the VEVENT (the event slug is unique + URL-safe). */
  uid: string;
  title: string;
  description: string | null;
  /** Best available place: full address when unlocked, else the city tier. */
  location: string | null;
  start: Date;
  end: Date;
}

/**
 * Project an event façade onto a {@link CalendarSource}, or `null` when there is no
 * concrete date to add (a date-TBD or undated event — nothing to put on a calendar).
 *
 * LOCATION respects tiering: prefer `location_text` (second tier, present only once the
 * RPC has unlocked the caller), fall back to `location_city` (first tier). A locked
 * viewer's payload has no `location_text`, so they can only ever export the city.
 */
export function eventCalendarSource(event: EventView): CalendarSource | null {
  if (event.date_tbd) return null;
  if (!event.starts_at) return null;

  const start = new Date(event.starts_at);
  if (Number.isNaN(start.getTime())) return null;

  let end = event.ends_at ? new Date(event.ends_at) : null;
  if (!end || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    end = new Date(start.getTime() + DEFAULT_DURATION_MS);
  }

  const location = event.location_text ?? event.location_city ?? null;

  return {
    uid: `${event.slug}@ju`,
    title: event.title,
    description: event.description ?? null,
    location,
    start,
    end,
  };
}

/** UTC "basic" date-time, e.g. `20260915T193000Z` — the form both ICS and Google use. */
function formatUtcBasic(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

/** Escape a value for an ICS text field (RFC 5545 §3.3.11). */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold a content line to ≤75 octets (RFC 5545 §3.1), breaking on code-point
 * boundaries so multi-byte characters are never split. Continuation lines begin with a
 * single space.
 */
function foldIcsLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;

  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    // First line may use 75 octets; continuation lines spend 1 on the leading space.
    const limit = parts.length === 0 ? 75 : 74;
    if (curBytes + chBytes > limit) {
      parts.push(cur);
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

/**
 * Render an `.ics` (RFC 5545 VCALENDAR) document for one event.
 *
 * `stamp` (DTSTAMP, the moment the object was produced) defaults to the start so the
 * output is deterministic without a clock; the UI passes the real current time.
 */
export function buildIcs(src: CalendarSource, stamp: Date = src.start): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//JU//Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${src.uid}`,
    `DTSTAMP:${formatUtcBasic(stamp)}`,
    `DTSTART:${formatUtcBasic(src.start)}`,
    `DTEND:${formatUtcBasic(src.end)}`,
    `SUMMARY:${escapeIcsText(src.title)}`,
  ];
  if (src.location) lines.push(`LOCATION:${escapeIcsText(src.location)}`);
  if (src.description) lines.push(`DESCRIPTION:${escapeIcsText(src.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/**
 * Build a Google Calendar "TEMPLATE" deep link that pre-fills a new event.
 *
 * Each value is RFC 3986 percent-encoded (spaces as `%20`), which Google parses cleanly;
 * the `dates` pair uses literal UTC-basic instants joined by `/` (both halves are
 * already URL-safe), so it stays readable and unencoded.
 */
export function buildGoogleCalendarUrl(src: CalendarSource): string {
  const query: string[] = [
    "action=TEMPLATE",
    `text=${encodeURIComponent(src.title)}`,
    `dates=${formatUtcBasic(src.start)}/${formatUtcBasic(src.end)}`,
  ];
  if (src.location) query.push(`location=${encodeURIComponent(src.location)}`);
  if (src.description) query.push(`details=${encodeURIComponent(src.description)}`);
  return `https://calendar.google.com/calendar/render?${query.join("&")}`;
}

/** A friendly download filename derived from the title; `event.ics` when it slugifies empty. */
export function icsFilename(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['’"`]/g, "") // drop apostrophes/quotes so "rain's" → "rains", not "rain-s"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${base || "event"}.ics`;
}
