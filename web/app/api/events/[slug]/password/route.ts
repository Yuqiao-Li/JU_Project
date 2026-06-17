import { NextResponse, type NextRequest } from "next/server";

import { readEventBySlug } from "@/lib/events/read-event";
import { ipFromHeaders } from "@/lib/ratelimit/ip";
import { rateLimit } from "@/lib/ratelimit/limiter";
import { rateLimitedResponse } from "@/lib/ratelimit/guard";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Password-attempt endpoint with INDEPENDENT rate limiting (task 2.3.5, D7amend).
 *
 * A password check costs one bcrypt verify, so unbounded attempts are both a
 * brute-force AND a bcrypt-DoS vector. We rate-limit per (IP, event) on the tight
 * `password_attempt` quota BEFORE running the verify, so an attacker can neither
 * guess freely nor force unlimited bcrypt work. The attempt is counted up front
 * (including the eventual success) precisely so the bcrypt can't be amplified.
 *
 * On success we ALSO return the now-unlocked façade (task 2.4a), read back through the
 * trusted role WITH the password so the gate can reveal the event in place without a
 * second round trip. It is still first-tier only: a correct password unlocks the
 * poster, not the address — the address needs an RSVP token (get_event_by_slug's
 * second tier). The password only ever travels in this POST body, never a URL.
 *
 * SCOPE: the verify itself is the existing SECURITY DEFINER `verify_event_password`
 * (real bcrypt). Minting the short-lived signed credential cookie that lets a
 * reload/poll skip the bcrypt re-check is task 2.5; it builds on this endpoint.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const ip = ipFromHeaders(request.headers);

  const limit = await rateLimit("password_attempt", `${ip}:${slug}`);
  if (!limit.success) return rateLimitedResponse(limit);

  let password: string | null = null;
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "password" in body) {
      const candidate = (body as { password: unknown }).password;
      if (typeof candidate === "string") password = candidate;
    }
  } catch {
    // Malformed/empty body → treated as a missing password below.
  }

  if (!password) {
    return NextResponse.json({ ok: false, error: "missing_password" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("verify_event_password", { slug, password });
  if (error) {
    return NextResponse.json({ ok: false, error: "verify_failed" }, { status: 500 });
  }

  if (data !== true) {
    return NextResponse.json({ ok: false });
  }

  // Verified: hand back the unlocked façade (first tier; no token ⇒ no address) so the
  // gate renders the event in place. Trusted role again, so private + this password
  // both pass the RPC's gates.
  const event = await readEventBySlug(slug, { password });
  return NextResponse.json({ ok: true, event });
}
