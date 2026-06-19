/**
 * 一键复用 (clone) pure helper (Step-10A, task 6 · dashboard.md 实现逻辑).
 *
 * Turns a host's OWN source event row into the `EventDefaults` that prefill a BRAND-NEW
 * create form (`/new?from=<id>`). The page does the (RLS-scoped) read; this module does the
 * field-copying so the rules are one tested place rather than scattered inline in the page.
 *
 * Kept PURE (no `server-only`, no DB, no React, no `@/` alias, no `Date.now()`) so it
 * unit-tests at the value boundary without a database — mirrors card.ts / capacity.ts.
 *
 * WHAT IT COPIES: the reusable shape of the gathering — title, description, where (city /
 * text / url), capacity + plus-ones, rsvp toggle, visibility, category, card design, chip-in,
 * and the look (cover / theme / effect).
 *
 * WHAT IT BUMPS: starts_at / ends_at move FORWARD one week. Adding exactly 7×24h to the UTC
 * instant lands the new event on the same wall-clock time, one week later (date_tbd is left
 * as-is — a TBD event clones to a TBD event, dates re-decided via the poll).
 *
 * WHAT IT DROPS (a clone is a fresh, unwritten event — NOT a copy of the original's identity
 * or its guest data): id, slug, status, host_id, the password hash, and every RSVP/guest.
 * The new row mints its own slug + draft status only when the host submits createEvent; no DB
 * write happens here.
 */

import { type EventDefaults } from "@/app/dashboard/events/event-form";
import { themeColorFromJson } from "@/lib/events/theme";

/** One week forward, in milliseconds — the 时间顺延 bump. */
const CLONE_BUMP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The subset of an `events` row the clone reads. Exactly the columns the source-event read
 * selects; nothing identity-bearing (id/slug/host_id/status/password) is needed here.
 */
export interface CloneSourceRow {
  title: string;
  description: string | null;
  date_tbd: boolean;
  starts_at: string | null;
  ends_at: string | null;
  location_text: string | null;
  location_url: string | null;
  location_city: string | null;
  visibility: string;
  capacity: number | null;
  allow_plus_ones: boolean;
  max_plus_ones: number;
  rsvp_enabled: boolean;
  cover_image_url: string | null;
  theme: unknown;
  effect: string | null;
  chip_in_url: string | null;
  chip_in_note: string | null;
  category: string | null;
  card_variant: string | null;
}

/**
 * Bump a stored UTC ISO instant forward by one week, preserving the wall-clock offset.
 * null (undated / TBD) stays null; an unparseable value also collapses to null rather than
 * carrying garbage into the form.
 */
function bumpForward(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + CLONE_BUMP_MS).toISOString();
}

/**
 * Build the create-form defaults for a cloned event from the host's own source row.
 *
 * The result is a CREATE shape: `id` is blank, `status` is "draft", `hasPassword` is false,
 * and the host's WeChat is left to the page (it comes from the profile, not the source event).
 * The host then edits the prefilled time + details and submits to mint a fresh event.
 */
export function cloneEventDefaults(source: CloneSourceRow): EventDefaults {
  return {
    // Fresh identity — never copied from the source.
    id: "",
    status: "draft",
    hasPassword: false,
    wechatId: "",
    // Copied content.
    title: source.title,
    description: source.description ?? "",
    locationText: source.location_text ?? "",
    locationUrl: source.location_url ?? "",
    locationCity: source.location_city ?? "",
    visibility: source.visibility === "private" ? "private" : "public",
    capacity: source.capacity,
    allowPlusOnes: source.allow_plus_ones,
    maxPlusOnes: source.max_plus_ones,
    rsvpEnabled: source.rsvp_enabled,
    category: source.category ?? "",
    cardVariant: source.card_variant ?? "",
    chipInUrl: source.chip_in_url ?? "",
    chipInNote: source.chip_in_note ?? "",
    coverImageUrl: source.cover_image_url ?? "",
    themeColor: themeColorFromJson(source.theme),
    effect: source.effect ?? "none",
    // Time — bumped forward one week; date_tbd carried as-is.
    dateTbd: source.date_tbd,
    startsAt: bumpForward(source.starts_at),
    endsAt: bumpForward(source.ends_at),
  };
}
