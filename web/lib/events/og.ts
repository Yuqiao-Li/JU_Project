import type { Metadata } from "next";

import type { EventView } from "./view";

/**
 * Open Graph / share-preview builder (task 6.2 [SECURITY]).
 *
 * WHAT A LINK PREVIEW MAY SHOW (task 禁止: "OG 不得泄露完整地址/名单"; SCHEMA 第一类).
 * The unfurl card for `/{slug}` is FIRST-TIER ONLY — title, cover image, description.
 * Those three are public façade fields (returned even before an RSVP, and even for a
 * locked password event), so a preview built from them alone can never carry the full
 * address (`location_text`, second tier) or the guest list (third tier / Can't-Go).
 *
 * This is a PURE function over the {@link EventView} façade — no `server-only`, no DB,
 * no network (mirrors `calendar.ts`). It reaches for ONLY the first-tier keys, so even
 * though the data layer already omits `location_text` for an un-unlocked / locked read,
 * the address could not leak here even if a future façade started carrying it: we never
 * read it. The page's `generateMetadata` resolves the façade with NO guest token and NO
 * password credential (an unfurl bot carries neither anyway), then hands it here.
 */

const SITE_NAME = "JU";

/** Keep OG descriptions to a sane length for a card; full text lives on the page. */
const OG_DESCRIPTION_MAX = 200;

/** Friendly first-tier line when a host left the description blank. Names nothing sensitive. */
const DEFAULT_DESCRIPTION = "You're invited. RSVP and see who's coming.";

/**
 * Build the share-preview metadata for an event, or a neutral fallback when there is
 * nothing public to preview.
 *
 * Returns a non-indexing placeholder for a missing event (`null`) or a draft (the page
 * 404s both) so a link preview never names an event that isn't actually published. A
 * password-locked façade (`locked: true`) omits `status`, so a published password event
 * still gets a real preview — its title/cover/description, never its address.
 */
export function buildEventOgMetadata(event: EventView | null): Metadata {
  if (!event || event.status === "draft") {
    return {
      title: "Event not found",
      robots: { index: false, follow: false },
    };
  }

  const title = event.title;
  const description = ogDescription(event.description);
  const image = ogImage(event.cover_image_url);

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: SITE_NAME,
      type: "website",
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

/** Trim the host's description to a card-sized, single-line summary (first tier). */
function ogDescription(raw: string | null | undefined): string {
  const text = raw?.replace(/\s+/g, " ").trim();
  if (!text) return DEFAULT_DESCRIPTION;
  return text.length > OG_DESCRIPTION_MAX
    ? `${text.slice(0, OG_DESCRIPTION_MAX - 1).trimEnd()}…`
    : text;
}

/**
 * The cover image URL for `og:image`, or null to omit it.
 *
 * Covers live in the public `event-covers` bucket and come back as ABSOLUTE Supabase
 * URLs; we accept only `http(s)` absolute URLs both to satisfy OG (which requires an
 * absolute image URL) and to refuse anything relative/odd that could trip metadata
 * resolution. No cover ⇒ no image (a plain `summary` card), never a leaked field.
 */
function ogImage(coverUrl: string | null | undefined): string | null {
  const url = coverUrl?.trim();
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}
