import "server-only";

import { parsePublicEvents, type PublicEvent } from "@/lib/events/public-events";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-side read of a host's PUBLIC events for the Organizer Profile (task 6.1).
 *
 * WHY THROUGH THE RPC (SCHEMA D2 / 安全模型 §1; task 禁止: "不 anon 直查表"). `anon` has
 * NO direct privilege on `events` — a public profile reaches a host's curated list ONLY
 * through `get_public_events_by_host` (SECURITY DEFINER), which resolves the username to
 * a host and returns ONLY their public + published events (never private / draft /
 * cancelled, never another host's, first-tier façade fields only — no full address).
 *
 * We use the ANON-keyed server client on purpose: this is fully public data and the
 * least-privileged path that a browser would take, so no service role is needed here
 * (contrast read-event.ts, which must be trusted to resolve PRIVATE events). The RPC
 * stays the security boundary; this wrapper only forwards the username and re-validates
 * the payload at the boundary, stripping any key outside the known public façade.
 *
 * An unknown username returns [] (the RPC gives no existence oracle, D2) — callers
 * render the same empty profile either way, so a real-but-eventless host and a missing
 * one are indistinguishable.
 *
 * ERROR vs EMPTY (H20): a real RPC failure (network / DB blip) must NOT masquerade as
 * "this host has no public events" — that hides their actual list behind the empty
 * state. We throw on a genuine RPC error so the route error boundary (app/error.tsx)
 * shows an error + retry. A null/empty payload with NO error stays [] — that is the
 * legitimate "no public events / unknown handle" case (D2), never an error.
 */
export async function readPublicEventsByHost(username: string): Promise<PublicEvent[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_public_events_by_host", { username });

  if (error) {
    console.error("[organizer] get_public_events_by_host failed:", error.message);
    throw new Error("Failed to load this organizer's events");
  }
  if (data == null) return [];
  return parsePublicEvents(data);
}
