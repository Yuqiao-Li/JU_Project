import { NextResponse, type NextRequest } from "next/server";

import {
  credentialSecret,
  passwordCookieName,
  verifyPasswordCredential,
} from "@/lib/events/password-credential";
import { readDatePoll } from "@/lib/events/read-date-poll";
import { readEventBySlug } from "@/lib/events/read-event";
import { readGuestList } from "@/lib/events/read-guest-list";
import { createClient } from "@/lib/supabase/server";
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

  // A logged-in viewer's account unlocks across devices without a localStorage token
  // (audit H16 / D1): the trusted read runs as service_role (auth.uid() null), so we pass
  // the authenticated user's id as the trusted viewer_id and the RPC's account branch
  // fires. Anon ⇒ null ⇒ no account unlock, exactly as before. The guest_token (when
  // present) still wins the unlock; this only adds the account fallback.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const event = await readEventBySlug(slug, {
    guestToken,
    passwordVerified,
    viewerId: user?.id ?? null,
  });
  if (!event) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Guest list (second tier, task 3.1) rides this SAME tiered funnel so the client polls
  // ONE endpoint. Fetched only for an UNLOCKED caller presenting a token — get_guest_list
  // re-checks the unlock gate itself, so this is an optimisation (skip the DB call for
  // locked/anon/SSR reads) on top of the RPC's hard gate, not the gate. A locked façade
  // (no `unlocked` / password box) carries no list.
  const guests =
    guestToken && event.unlocked === true ? await readGuestList(slug, guestToken) : [];

  // Date poll (task 5.1) rides the same tiered funnel so the client polls ONE endpoint.
  // Only fetched for a TBD event (the poll is meaningless once a date is fixed), through
  // the trusted role — get_date_poll re-applies the private + unlock gates itself.
  const poll = event.date_tbd === true ? await readDatePoll(slug, guestToken) : null;

  return NextResponse.json(
    { event, guests, poll },
    { headers: { "Cache-Control": "no-store" } },
  );
}
