import "server-only";

import { eventViewSchema, type EventView } from "@/lib/events/view";
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

export type { EventView };

export interface ReadEventOptions {
  /** The guest's own token (from localStorage); scopes unlock to THIS event. */
  guestToken?: string | null;
  /** Candidate password for a password-protected event. */
  password?: string | null;
  /**
   * Trusted "password already satisfied" signal (task 2.5). Set ONLY after the
   * caller has validated the guest's signed credential cookie for THIS slug; it lets
   * `get_event_by_slug` skip the password gate without re-running bcrypt (读/轮询不再
   * 重哈希). Honoured by the RPC only for the service-role path, so it can never widen
   * exposure beyond the trusted server.
   */
  passwordVerified?: boolean;
  /**
   * Trusted viewer identity (audit H16 / D1). Set ONLY to the logged-in user's
   * `auth.uid()` after the server has authenticated the session; it lets
   * `get_event_by_slug` unlock the event via the account branch
   * (guests.user_id = viewer_id) WITHOUT a localStorage token, so a logged-in guest
   * re-sees the unlocked tier across devices. The RPC honours it only for the
   * service-role path (this helper IS that path), so an anon client passing it
   * directly is ignored and can never self-unlock another account.
   */
  viewerId?: string | null;
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
    password_verified: opts.passwordVerified ? true : undefined,
    viewer_id: opts.viewerId ?? undefined,
  });

  if (error || data == null) return null;

  const parsed = eventViewSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
