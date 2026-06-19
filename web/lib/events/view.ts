import { z } from "zod";

/**
 * The shape `get_event_by_slug` returns — the single public façade of an event.
 *
 * Extracted here (no `server-only`) so it can be shared by the trusted server read
 * (`read-event.ts`) AND by the client components that render an event (the public
 * `/{slug}` page, the password gate). Importing the TYPE into the client never pulls
 * a trusted-role module along with it.
 *
 * All sensitive/conditional fields are optional because the RPC OMITS them
 * (省略而非置0) when the caller isn't entitled: `location_text`/`location_url` only
 * appear once unlocked (second tier); `going_count`/`capacity_remaining` only when the
 * count rule permits (D7②). A password-locked event returns only the minimal locked
 * subset (title/cover/description/…), so most keys are absent then too. Unknown keys
 * are stripped by zod's default strip — defence in depth against a third-tier field
 * (contact, other tokens, raw hash, Can't-Go list, answers) ever appearing here.
 */
export const eventViewSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  cover_image_url: z.string().nullable().optional(),
  theme: z.unknown().optional(),
  effect: z.string().nullable().optional(),
  // Step-10A: the 局分类 + chosen 局卡 design. Non-sensitive public façade fields the
  // card art needs — always present on the normal tiered response (absent on the
  // password-locked minimal payload, hence optional).
  category: z.string().nullable().optional(),
  card_variant: z.string().nullable().optional(),
  location_city: z.string().nullable().optional(),
  location_text: z.string().nullable().optional(),
  location_url: z.string().nullable().optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  date_tbd: z.boolean().optional(),
  host_display_name: z.string().nullable().optional(),
  rsvp_enabled: z.boolean().optional(),
  visibility: z.string(),
  capacity: z.number().nullable().optional(),
  allow_plus_ones: z.boolean().optional(),
  max_plus_ones: z.number().optional(),
  hide_guest_list: z.boolean().optional(),
  hide_guest_count: z.boolean().optional(),
  hide_feed_timestamps: z.boolean().optional(),
  chip_in_url: z.string().nullable().optional(),
  chip_in_note: z.string().nullable().optional(),
  status: z.string().optional(),
  requires_password: z.boolean().optional(),
  locked: z.boolean().optional(),
  // Round-4: the event is "locked"/finalized (manual lock or auto within 1 day of
  // start). Always present on the normal tiered façade; absent on a password-locked
  // minimal payload. Closes new RSVPs and opens the two-way contact reveal.
  is_locked: z.boolean().optional(),
  // Round-4: the host's WeChat, revealed ONLY to an unlocked (RSVP'd) viewer once the
  // event is locked AND within the burn window (阅后即焚). The data layer omits it
  // otherwise, so a missing key reads as "not revealed".
  host_wechat_id: z.string().nullable().optional(),
  // Step-10A: the host's GENERAL contact, revealed under the IDENTICAL gate as
  // host_wechat_id (unlocked RSVP'd viewer + locked + burn window, 阅后即焚). The data
  // layer omits it otherwise, so a missing key reads as "not revealed".
  host_contact: z.string().nullable().optional(),
  unlocked: z.boolean().optional(),
  going_count: z.number().optional(),
  capacity_remaining: z.number().nullable().optional(),
});

export type EventView = z.infer<typeof eventViewSchema>;
