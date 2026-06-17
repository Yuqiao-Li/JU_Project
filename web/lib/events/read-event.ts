import "server-only";

import { z } from "zod";

import { createServiceClient } from "@/lib/supabase/service";

/**
 * Trusted server-side read of an event by slug (task 2.3.5 — private convergence).
 *
 * WHY THIS EXISTS (SCHEMA D3 / 安全模型 §3; task 禁止: "private 不得对 anon 裸奔").
 * A PRIVATE event's `get_event_by_slug` returns NULL to anyone who isn't
 * `service_role` — so a private event can only be read through a TRUSTED server
 * path, never by an anon client calling the RPC directly. This helper IS that path:
 * it uses the service-role client (server-only via `service.ts`'s `server-only`
 * import) so SSR pages and the read/poll Route Handler can resolve private events,
 * while the database stays the boundary that turns anon away.
 *
 * It does NOT widen exposure: every field-tier, the private gate, the password gate
 * and the count rule are all enforced INSIDE `get_event_by_slug`. This wrapper only
 * (a) routes the call through the trusted role and (b) re-validates the payload at
 * the boundary, stripping any unexpected key so nothing outside the known façade can
 * ever leak through.
 */

/**
 * The shape `get_event_by_slug` returns. All sensitive/conditional fields are
 * optional because the RPC OMITS them (省略而非置0) when the caller isn't entitled:
 * `location_text`/`location_url` only appear once unlocked; `going_count`/
 * `capacity_remaining` only when the count rule permits. Unknown keys are stripped
 * by default (zod), a defence-in-depth against third-tier fields ever appearing.
 */
const eventViewSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  cover_image_url: z.string().nullable().optional(),
  theme: z.unknown().optional(),
  effect: z.string().nullable().optional(),
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
  unlocked: z.boolean().optional(),
  going_count: z.number().optional(),
  capacity_remaining: z.number().nullable().optional(),
});

export type EventView = z.infer<typeof eventViewSchema>;

export interface ReadEventOptions {
  /** The guest's own token (from localStorage); scopes unlock to THIS event. */
  guestToken?: string | null;
  /** Candidate password for a password-protected event. */
  password?: string | null;
}

/**
 * Resolve an event façade through the trusted role. Returns null when the slug is
 * unknown, when a private event is denied (the RPC returns null), or when the
 * payload fails validation — callers render notFound()/404 uniformly so a private
 * event isn't distinguishable from a missing one.
 */
export async function readEventBySlug(
  slug: string,
  opts: ReadEventOptions = {},
): Promise<EventView | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("get_event_by_slug", {
    slug,
    guest_token: opts.guestToken ?? undefined,
    password: opts.password ?? undefined,
  });

  if (error || data == null) return null;

  const parsed = eventViewSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
