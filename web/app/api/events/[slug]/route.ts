import { NextResponse, type NextRequest } from "next/server";

import {
  credentialSecret,
  passwordCookieName,
  verifyPasswordCredential,
} from "@/lib/events/password-credential";
import { readEventBySlug } from "@/lib/events/read-event";
import { ipFromHeaders } from "@/lib/ratelimit/ip";
import { rateLimit } from "@/lib/ratelimit/limiter";
import { rateLimitedResponse } from "@/lib/ratelimit/guard";

/**
 * Rate-limited tiered event read / poll endpoint (task 2.3.5 infrastructure).
 *
 * The single read funnel the client polls for live data. It enforces the read-side
 * rate limit (task 禁止: limiting lives in the Next layer, NOT Postgres) and routes
 * the read through the TRUSTED role so private events resolve server-side only —
 * anon never reaches the private RPC directly. The field-tiering / private /
 * password gates all live inside `get_event_by_slug`; this handler just funnels.
 *
 * Quota selection (D4/D14): a request carrying a `token` is an engaged poller and
 * gets the lenient `event_poll` quota so normal visibility-aware polling is never
 * 429'd; a fresh/anon read of a new slug gets the strict `event_read` quota that
 * blunts scraping. Both are keyed per real client IP. (Presenting a token to obtain
 * the lenient quota is at most a per-IP 4× margin — still bounded, and the DB
 * write-limit + private gate remain the hard security boundary.)
 *
 * `token` is read from the query string only because the client holds it in
 * localStorage and sends it on the request; it is NEVER put into a shareable URL by
 * the app (see DESIGN-TONE: guest_token never in a shareable location).
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const ip = ipFromHeaders(request.headers);
  const guestToken = request.nextUrl.searchParams.get("token");

  const quota = guestToken ? "event_poll" : "event_read";
  const limit = await rateLimit(quota, ip);
  if (!limit.success) return rateLimitedResponse(limit);

  // A password event polls with the signed credential cookie minted at unlock (task
  // 2.5). Validate the cheap MAC here and pass `passwordVerified` so the trusted read
  // resumes normal tiering without re-running bcrypt (读/轮询不再重哈希). Invalid/absent
  // ⇒ false ⇒ the password gate stays shut.
  const credential = request.cookies.get(passwordCookieName(slug))?.value ?? null;
  const passwordVerified = credential
    ? verifyPasswordCredential(slug, credential, credentialSecret())
    : false;

  const event = await readEventBySlug(slug, { guestToken, passwordVerified });
  if (!event) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json({ event }, { headers: { "Cache-Control": "no-store" } });
}
