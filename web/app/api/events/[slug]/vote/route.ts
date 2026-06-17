import { NextResponse, type NextRequest } from "next/server";

import { voteInputSchema } from "@/lib/events/date-poll";
import { readDatePoll } from "@/lib/events/read-date-poll";
import { createClient } from "@/lib/supabase/server";

/**
 * Date-poll vote endpoint (task 5.1) — the trusted hop in front of the SECURITY
 * DEFINER `vote_dates` RPC. anon has NO direct privilege on date_votes; every guest
 * vote flows through here.
 *
 * The DB function is the security boundary: it gates the write on the shared unlock
 * helper (a guest must be RSVP'd — token/account, event-scoped), resolves the voter's
 * guest_id server-side from the verified token (a forged/cross-event token unlocks
 * nothing), and treats option_ids as the COMPLETE new selection (replacing multi-select
 * upsert — de-selected options dropped, foreign option_ids ignored). We call through the
 * cookie-bound server client so an account-linked guest's auth.uid() reaches the gate,
 * then re-read the poll (with the same token) so the response carries the fresh tally +
 * the guest's confirmed selection. The token rides only in the POST body the app builds,
 * never a shareable URL (DESIGN-TONE: guest_token never in a shareable location).
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;

  let raw: unknown = null;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const parsed = voteInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Check your vote." },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Cookie-bound server client so a logged-in guest's auth.uid() reaches the RPC's
  // account-fallback gate. Still the anon key — the DEFINER body is the authority.
  const supabase = await createClient();
  const { error } = await supabase.rpc("vote_dates", {
    slug,
    guest_token: input.token,
    option_ids: input.option_ids,
  });

  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    // Unlock gate (guest not RSVP'd) — surface as 403 so the client shows the RSVP prompt.
    if (msg.includes("rsvp")) {
      return NextResponse.json(
        { ok: false, error: "not_allowed", message: "RSVP to vote on the date." },
        { status: 403 },
      );
    }
    if (msg.includes("not found")) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (msg.includes("cancelled")) {
      return NextResponse.json(
        { ok: false, error: "cancelled", message: "This event was cancelled." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "vote_failed", message: "Couldn’t save your vote. Try again." },
      { status: 400 },
    );
  }

  // Re-read the poll with the same token so the client gets the fresh tally + confirmed
  // selection in one round trip. Routed through the trusted role (private events resolve
  // server-side only); the RPC re-applies the private + unlock gates regardless.
  const poll = await readDatePoll(slug, input.token);
  return NextResponse.json({ ok: true, poll }, { headers: { "Cache-Control": "no-store" } });
}
