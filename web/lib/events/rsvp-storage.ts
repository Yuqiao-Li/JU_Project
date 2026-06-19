import type { RsvpStatus } from "./rsvp";

/**
 * The guest's own RSVP, cached in localStorage so a return visit prefills the form
 * and re-unlocks the event (task 2.4b).
 *
 * THE TOKEN IS THE GUEST CREDENTIAL (SCHEMA §URL boundary / DESIGN-TONE). It lives
 * ONLY in localStorage — never the banned per-session web storage, never a cookie the
 * app sets here, and ABOVE ALL never in a shareable URL. It is sent only to our own
 * endpoints (the submit POST body and the poll query the app constructs), so it never
 * leaks into anything a guest could copy and share. The other fields are a convenience
 * cache of the guest's last submission used purely to prefill the form on their own
 * device; the canonical RSVP/visibility state always comes back from the server.
 *
 * Namespaced per slug so two events open on the same origin can't collide.
 */
export interface RsvpRecord {
  /** The guest credential. Required — without it there is nothing worth caching. */
  token: string;
  /** Last confirmed status (may be 'waitlisted', a server outcome). */
  status: RsvpStatus | "waitlisted" | string;
  plus_ones: number;
  display_name: string;
  contact: string | null;
  /**
   * Round-4: the guest's WeChat, cached so a return visit prefills it. Optional so a
   * record written before this field existed (or by a caller that doesn't set it) still
   * parses — `loadRsvpRecord` normalizes a missing value to null.
   */
  wechat_id?: string | null;
}

const PREFIX = "partiful:rsvp:";

function keyFor(slug: string): string {
  return `${PREFIX}${slug}`;
}

/** Read the guest's cached RSVP for this event, or null. SSR/JSON-error safe. */
export function loadRsvpRecord(slug: string): RsvpRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(slug));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as RsvpRecord).token === "string" &&
      (parsed as RsvpRecord).token.length > 0
    ) {
      const r = parsed as RsvpRecord;
      return {
        token: r.token,
        status: typeof r.status === "string" ? r.status : "going",
        plus_ones: typeof r.plus_ones === "number" ? r.plus_ones : 0,
        display_name: typeof r.display_name === "string" ? r.display_name : "",
        contact: typeof r.contact === "string" ? r.contact : null,
        wechat_id: typeof r.wechat_id === "string" ? r.wechat_id : null,
      };
    }
  } catch {
    // Unparseable / storage unavailable (private mode) — behave as no record.
  }
  return null;
}

/** Persist the guest's RSVP for this event. No-op when storage is unavailable. */
export function saveRsvpRecord(slug: string, record: RsvpRecord): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(slug), JSON.stringify(record));
  } catch {
    // Storage full / blocked — the server still has the canonical record; ignore.
  }
}
