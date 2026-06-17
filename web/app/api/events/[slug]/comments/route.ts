import { NextResponse, type NextRequest } from "next/server";

import { commentInputSchema, parseComment } from "@/lib/events/comments";
import { readComments } from "@/lib/events/read-comments";
import { ipFromHeaders } from "@/lib/ratelimit/ip";
import { rateLimit } from "@/lib/ratelimit/limiter";
import { rateLimitedResponse } from "@/lib/ratelimit/guard";
import { createClient } from "@/lib/supabase/server";

/**
 * Activity-Feed comment endpoint (task 4.1) — the trusted hop in front of the
 * SECURITY DEFINER comment RPCs. anon has NO direct privilege on the comments table;
 * every guest read/write of a comment flows through here.
 *
 * GET — the read-open feed poll (D6 读开放). Read-side rate limited at the Next layer
 * (task 禁止: limiting lives in Next, NOT Postgres), routed through the TRUSTED role so
 * a PRIVATE event's feed resolves server-side only (get_comments returns [] to non-
 * service_role — the D3 gate). The visibility/desensitization all live inside the RPC;
 * this handler just funnels and re-validates. A `token` only selects the lenient poll
 * quota — the read itself is open, so the feed is the same with or without one.
 *
 * POST — add a comment via `add_comment`. Two things only the server can do correctly:
 *  1. REAL CLIENT IP for the DB write-limit (D14/G7): add_comment buckets its
 *     per-(event, identity) rate limit on `client_fingerprint`; only the server knows
 *     the un-spoofable Vercel-injected IP, so each caller is isolated in its own bucket.
 *  2. HOST AUTHORSHIP (D6): the call goes through the cookie-bound server client, so a
 *     logged-in host's `auth.uid()` reaches the RPC and binds the author to the host.
 * The DB function is the security boundary — it gates the write on the shared unlock
 * helper (a guest must be RSVP'd), binds the author server-side (a forged guest_id/
 * host_id has nowhere to land), forces host-only when rsvp_enabled=false, never writes
 * a gif, and enforces the write-side limit that still bites a caller who bypasses this
 * route. The `token` is read from the request body the app builds — never a shareable
 * URL (DESIGN-TONE: guest_token never in a shareable location).
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const ip = ipFromHeaders(request.headers);
  const hasToken = !!request.nextUrl.searchParams.get("token");

  // An engaged poller (token present) gets the lenient poll quota so visibility-aware
  // feed polling is never falsely 429'd; a fresh/anon read gets the strict cap (D4).
  const limit = await rateLimit(hasToken ? "event_poll" : "event_read", ip);
  if (!limit.success) return rateLimitedResponse(limit);

  const comments = await readComments(slug);
  return NextResponse.json({ comments }, { headers: { "Cache-Control": "no-store" } });
}

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

  const parsed = commentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Check your comment." },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Real client IP → the DB write-limit identity bucket (D14). Never "no limit".
  const fingerprint = ipFromHeaders(request.headers);

  // Cookie-bound server client so a logged-in host's auth.uid() reaches the RPC (host
  // author binding, D6). Still the anon key — the RPC's SECURITY DEFINER body is the
  // authority that gates the write, not this client.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_comment", {
    slug,
    guest_token: input.token ?? undefined,
    body: input.body,
    client_fingerprint: fingerprint,
  });

  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    // The DB write-limit raises with a "rate limit" message — surface as 429.
    if (msg.includes("rate limit")) {
      return NextResponse.json(
        { ok: false, error: "rate_limited", message: "Too many comments — wait a moment and try again." },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Unlock gate (guest not RSVP'd) or host-only (rsvp_enabled=false): the guest may
    // not post. 403 so the client shows the "RSVP first" affordance distinctly.
    if (msg.includes("rsvp required") || msg.includes("host-only")) {
      return NextResponse.json(
        { ok: false, error: "not_allowed", message: "RSVP to join the conversation." },
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
    // Anything else: a generic failure, without echoing raw DB text to the client.
    return NextResponse.json(
      { ok: false, error: "comment_failed", message: "Couldn’t post your comment. Try again." },
      { status: 400 },
    );
  }

  // Validate the RPC payload at the boundary — strip anything unexpected so only the
  // known desensitized shape (no author identifiers) ever reaches the client.
  const comment = parseComment(data);
  if (!comment) {
    return NextResponse.json(
      { ok: false, error: "comment_failed", message: "Couldn’t post your comment. Try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, comment }, { headers: { "Cache-Control": "no-store" } });
}
