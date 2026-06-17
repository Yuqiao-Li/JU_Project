import "server-only";

import { parseComments, type CommentEntry } from "@/lib/events/comments";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Trusted server-side read of an event's comment feed (task 4.1).
 *
 * WHY THROUGH THE TRUSTED ROLE (SCHEMA 安全模型 §1 单一读路径; D3; task 禁止: "不给 anon
 * 开 comments 原表"). `anon` has NO direct privilege on the comments table — the feed
 * reaches a viewer ONLY through `get_comments` (SECURITY DEFINER). Routing it through
 * the SAME trusted Next funnel as the event read keeps every comment read on one path:
 * a PRIVATE event's feed resolves only server-side (get_comments returns [] to anyone
 * who isn't service_role — D3 visibility gate), exactly like get_event_by_slug. The RPC
 * stays the security boundary — read-open, visibility-gated, and desensitized to
 * id/body/author display_name/is_host/created_at; this wrapper only forwards the call
 * and re-validates the payload at the boundary.
 *
 * READ IS OPEN (D6): unlike the guest list, there is NO unlock gate — an un-RSVP'd
 * viewer may read the feed — so we do NOT short-circuit on a missing token.
 */
export async function readComments(slug: string): Promise<CommentEntry[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("get_comments", { slug });

  if (error || data == null) return [];
  return parseComments(data);
}
