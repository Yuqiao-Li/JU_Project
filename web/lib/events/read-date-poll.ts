import "server-only";

import { parseDatePoll, type DatePoll } from "@/lib/events/date-poll";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Trusted server-side read of an event's date poll (task 5.1).
 *
 * WHY THROUGH THE TRUSTED ROLE (SCHEMA 安全模型 §1 单一读路径; G1). anon has NO direct
 * privilege on date_options / date_votes — the poll reaches a guest ONLY through
 * `get_date_poll` (SECURITY DEFINER). Routing it through the SAME trusted Next funnel as
 * the event + guest-list reads keeps every guest read on one path: one server hop, never
 * a direct browser→Supabase call, and a PRIVATE event's poll resolves only server-side
 * (get_date_poll returns null to non-owner/non-service callers, the D3 gate).
 *
 * The RPC stays the boundary: it gates the private read, computes the tally, and resolves
 * the caller's own selection through the shared unlock gate. This wrapper only forwards
 * the guest's token and re-validates the payload at the boundary. Returns null when the
 * slug is unknown, the private gate denies, or validation fails.
 */
export async function readDatePoll(
  slug: string,
  guestToken?: string | null,
): Promise<DatePoll | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("get_date_poll", {
    slug,
    guest_token: guestToken ?? undefined,
  });

  if (error || data == null) return null;
  return parseDatePoll(data);
}
