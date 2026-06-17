import { NextResponse, type NextRequest } from "next/server";

import { rsvpInputSchema, rsvpResultSchema } from "@/lib/events/rsvp";
import { ipFromHeaders } from "@/lib/ratelimit/ip";
import { createClient } from "@/lib/supabase/server";

/**
 * Guest RSVP submit endpoint (task 2.4b) — the trusted server hop in front of the
 * SECURITY DEFINER `submit_rsvp` RPC.
 *
 * WHY A SERVER HOP (not a direct browser RPC call). Two things only the server can do
 * correctly:
 *  1. REAL CLIENT IP for the DB write-limit (D14/G7). `submit_rsvp` buckets its
 *     per-(event, identity) rate limit on `client_fingerprint`; only the server knows
 *     the true client IP (Vercel-injected, un-spoofable). Passing it here isolates
 *     each guest in their own bucket — a browser could never be trusted to report it,
 *     so a direct call would dump every anon guest into one shared per-event bucket.
 *  2. ACCOUNT LINKING (D1). We call through the cookie-bound server client, so a
 *     logged-in visitor's `auth.uid()` reaches the RPC and `guests.user_id` gets set
 *     server-side ("我参加的局" / cross-device recovery). An anonymous guest simply has
 *     no session → user_id stays null. The guest NEVER needs to log in either way.
 *
 * The DB function remains the security boundary: it re-validates inputs, mints/keeps
 * the guest_token server-side (a client-chosen token can at most match an existing
 * event-scoped guest, never forge one), decides going-vs-waitlisted under an advisory
 * lock, and enforces the write-side rate limit that still bites a caller who bypasses
 * this route ("绕 Next 也拦"). We add no read-side Upstash limit here — write limiting
 * is DB-side by design (SCHEMA §限流).
 *
 * The response carries ONLY the guest's own confirmation (token + confirmed status,
 * D15); the client stores the token in localStorage and re-reads the tiered event via
 * the poll endpoint to reveal the unlocked view. The token never rides in a URL.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const parsed = rsvpInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Check the form." },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Real client IP → the DB write-limit identity bucket (D14). Falls back to a shared
  // bucket when unresolved, never to "no limit".
  const fingerprint = ipFromHeaders(request.headers);

  // Cookie-bound server client so a logged-in guest's auth.uid() reaches the RPC
  // (account linking, D1). Still the anon key — the RPC's SECURITY DEFINER body is the
  // authority, not this client.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_rsvp", {
    slug,
    display_name: input.display_name,
    status: input.status,
    guest_token: input.guest_token ?? undefined,
    plus_ones: input.plus_ones,
    contact: input.contact ?? undefined,
    client_fingerprint: fingerprint,
  });

  if (error) {
    // The DB write-limit raises a P0001 with a "rate limit" message — surface it as a
    // 429 so the client can back off, distinct from a bad request.
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("rate limit")) {
      return NextResponse.json(
        { ok: false, error: "rate_limited", message: "Too many tries — wait a moment and try again." },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (msg.includes("not found")) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (msg.includes("disabled")) {
      return NextResponse.json(
        { ok: false, error: "rsvp_disabled", message: "The host turned off replies for this event." },
        { status: 409 },
      );
    }
    if (msg.includes("cancelled")) {
      return NextResponse.json(
        { ok: false, error: "cancelled", message: "This event was cancelled." },
        { status: 409 },
      );
    }
    // Anything else: a generic failure, without echoing raw DB text to the client.
    return NextResponse.json(
      { ok: false, error: "submit_failed", message: "Couldn't save your RSVP. Try again." },
      { status: 400 },
    );
  }

  // Validate the RPC payload at the boundary — strip anything unexpected so only the
  // known confirmation shape (token + confirmed status) ever reaches the client.
  const result = rsvpResultSchema.safeParse(data);
  if (!result.success) {
    return NextResponse.json(
      { ok: false, error: "submit_failed", message: "Couldn't save your RSVP. Try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, rsvp: result.data }, { headers: { "Cache-Control": "no-store" } });
}
