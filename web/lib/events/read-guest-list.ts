import "server-only";

import { parseGuestList, type GuestListEntry } from "@/lib/events/guest-list";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Trusted server-side read of an event's guest list (task 3.1).
 *
 * WHY THROUGH THE TRUSTED ROLE (SCHEMA 安全模型 §1 单一读路径; task 禁止: "不给 anon
 * 开原表 SELECT"). `anon` has NO direct privilege on guests/rsvps — the list reaches a
 * guest ONLY through `get_guest_list` (SECURITY DEFINER). Routing it through the SAME
 * trusted Next funnel as the event read keeps every guest read on one path: one
 * rate-limited hop, never a direct browser→Supabase RPC call, and a private event's
 * list never resolves except server-side. The RPC stays the security boundary — it is
 * unlock-gated, Going/Maybe only, and desensitized; this wrapper only forwards the
 * guest's token and re-validates the payload at the boundary.
 *
 * The unlock decision is the RPC's: a forged / cross-event / absent token yields [].
 * We short-circuit to [] without a DB round-trip when there is no token at all (an
 * un-RSVP'd / SSR caller is never unlocked), so the SSR HTML never carries a list.
 */
export async function readGuestList(
  slug: string,
  guestToken: string | null | undefined,
): Promise<GuestListEntry[]> {
  // No token ⇒ not unlocked ⇒ no list. Skip the call entirely (and keep the list out
  // of any SSR render, which has no token).
  if (!guestToken) return [];

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("get_guest_list", {
    slug,
    guest_token: guestToken,
  });

  if (error || data == null) return [];
  return parseGuestList(data);
}
