import { describe, expect, it } from "vitest";

import {
  buildGoogleCalendarUrl,
  buildIcs,
  eventCalendarSource,
  icsFilename,
} from "../lib/events/calendar";
import type { EventView } from "../lib/events/view";

/**
 * Task 2.6 — "Add to calendar" (Google Calendar template URL + .ics download).
 *
 * Pure unit assertions over the calendar builders. The whole feature derives from the
 * tiered event façade (`EventView`) the page already holds, so:
 *   - it never touches `contact` (the façade never carries one — 不依赖 contact);
 *   - the calendar LOCATION inherits the data layer's tiering: the full address
 *     (`location_text`) only exists in the payload once unlocked, so a locked viewer
 *     can only ever produce the city — there is nothing here to leak.
 *
 * Acceptance (【测试】): the .ics carries correct DTSTART / SUMMARY / LOCATION.
 */

/** A minimal façade with the fields the calendar needs (required keys + overrides). */
function ev(overrides: Partial<EventView> = {}): EventView {
  return {
    slug: "rains-bday-x7k2m9qpvw",
    title: "Rain's Birthday",
    visibility: "public",
    starts_at: "2026-09-15T19:30:00Z",
    ends_at: "2026-09-15T22:00:00Z",
    location_city: "Brooklyn",
    location_text: "12 Example St, Brooklyn NY",
    unlocked: true,
    ...overrides,
  };
}

describe("task 2.6: eventCalendarSource (façade → calendar fields, tier-aware)", () => {
  it("maps the first/second-tier façade onto a calendar source", () => {
    const src = eventCalendarSource(ev());
    expect(src).not.toBeNull();
    if (!src) return;
    expect(src.title).toBe("Rain's Birthday");
    expect(src.start.toISOString()).toBe("2026-09-15T19:30:00.000Z");
    expect(src.end.toISOString()).toBe("2026-09-15T22:00:00.000Z");
    expect(src.uid).toContain("rains-bday-x7k2m9qpvw");
  });

  it("prefers the full address when unlocked, falls back to the city when locked", () => {
    const unlocked = eventCalendarSource(ev({ unlocked: true }));
    expect(unlocked?.location).toBe("12 Example St, Brooklyn NY");

    // A locked viewer never receives location_text from the RPC — only the city tier.
    const locked = eventCalendarSource(ev({ unlocked: false, location_text: undefined }));
    expect(locked?.location).toBe("Brooklyn");
  });

  it("defaults the end to start + 2h when the event has no end time", () => {
    const src = eventCalendarSource(ev({ ends_at: null }));
    expect(src?.end.toISOString()).toBe("2026-09-15T21:30:00.000Z");
  });

  it("returns null when there is no concrete date (date TBD / no start)", () => {
    expect(eventCalendarSource(ev({ date_tbd: true }))).toBeNull();
    expect(eventCalendarSource(ev({ starts_at: null }))).toBeNull();
    expect(eventCalendarSource(ev({ starts_at: "not-a-date" }))).toBeNull();
  });

  it("never carries a contact (the façade has none; 不依赖 contact)", () => {
    const src = eventCalendarSource(ev());
    expect(JSON.stringify(src)).not.toMatch(/contact/i);
  });
});

describe("task 2.6: buildIcs (.ics carries correct DTSTART / SUMMARY / LOCATION)", () => {
  const src = eventCalendarSource(ev());

  it("emits a well-formed VCALENDAR/VEVENT", () => {
    if (!src) throw new Error("source");
    const ics = buildIcs(src);
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain(`UID:${src.uid}`);
    // RFC 5545 lines are CRLF-delimited.
    expect(ics).toContain("\r\n");
  });

  it("carries the correct DTSTART, DTEND, SUMMARY and LOCATION (UTC basic form)", () => {
    if (!src) throw new Error("source");
    const ics = buildIcs(src);
    expect(ics).toContain("DTSTART:20260915T193000Z");
    expect(ics).toContain("DTEND:20260915T220000Z");
    expect(ics).toContain("SUMMARY:Rain's Birthday");
    expect(ics).toContain("LOCATION:12 Example St\\, Brooklyn NY");
  });

  it("always includes a DTSTAMP (defaults deterministically; overridable)", () => {
    if (!src) throw new Error("source");
    expect(buildIcs(src)).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
    expect(buildIcs(src, new Date("2026-01-02T03:04:05Z"))).toContain("DTSTAMP:20260102T030405Z");
  });

  it("escapes RFC 5545 special characters in text fields", () => {
    const s = eventCalendarSource(
      ev({ title: "Dinner, drinks; chill", description: "line1\nline2", location_text: "A, B; C" }),
    );
    if (!s) throw new Error("source");
    const ics = buildIcs(s);
    expect(ics).toContain("SUMMARY:Dinner\\, drinks\\; chill");
    expect(ics).toContain("DESCRIPTION:line1\\nline2");
    expect(ics).toContain("LOCATION:A\\, B\\; C");
  });

  it("omits LOCATION/DESCRIPTION lines entirely when absent", () => {
    const s = eventCalendarSource(
      ev({ location_text: undefined, location_city: null, description: null }),
    );
    if (!s) throw new Error("source");
    const ics = buildIcs(s);
    expect(ics).not.toContain("LOCATION:");
    expect(ics).not.toContain("DESCRIPTION:");
  });
});

describe("task 2.6: buildGoogleCalendarUrl (template URL)", () => {
  const src = eventCalendarSource(ev());

  it("targets the Google Calendar TEMPLATE action with title/dates/location", () => {
    if (!src) throw new Error("source");
    const url = buildGoogleCalendarUrl(src);
    expect(url.startsWith("https://calendar.google.com/calendar/render?")).toBe(true);
    expect(url).toContain("action=TEMPLATE");
    expect(url).toContain("dates=20260915T193000Z/20260915T220000Z");
    // Title + location are URL-encoded query params.
    expect(url).toContain(`text=${encodeURIComponent("Rain's Birthday")}`);
    expect(url).toContain(`location=${encodeURIComponent("12 Example St, Brooklyn NY")}`);
  });
});

describe("task 2.6: icsFilename", () => {
  it("slugifies the title and appends .ics, falling back to event.ics", () => {
    expect(icsFilename("Rain's Birthday")).toBe("rains-birthday.ics");
    expect(icsFilename("派对")).toBe("event.ics");
    expect(icsFilename("   ")).toBe("event.ics");
  });
});
