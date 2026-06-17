import { NextResponse, type NextRequest } from "next/server";

import {
  credentialSecret,
  passwordCookieName,
  passwordCredentialCookieOptions,
  signPasswordCredential,
} from "@/lib/events/password-credential";
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
 * CREDENTIAL (task 2.5, D7⑤/amend). On a correct password we mint a short-lived,
 * HMAC-signed credential scoped to THIS slug and set it as an HttpOnly cookie. Later
 * reloads/polls send that cookie; the trusted SSR/poll path validates the cheap MAC and
 * reads with `password_verified` so the bcrypt is NEVER re-run ("读/轮询不再重哈希").
 * The cookie carries no plaintext password — only the signature — so nothing secret is
 * stored or transmitted, and it only ever travels in the cookie, never a URL.
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
  // gate renders the event in place. We re-read with the trusted `passwordVerified` flag
  // (not the plaintext) — the password is already confirmed, so this avoids a SECOND
  // bcrypt at unlock; the verify above is the only hash. Trusted role, so a private
  // event still resolves here too.
  const event = await readEventBySlug(slug, { passwordVerified: true });

  // Mint the short-lived signed credential so subsequent reloads/polls skip bcrypt. The
  // cookie holds only the slug-scoped signature — no plaintext password (密码不得明文存/传).
  const response = NextResponse.json({ ok: true, event });
  const credential = signPasswordCredential(slug, credentialSecret());
  response.cookies.set(passwordCookieName(slug), credential, passwordCredentialCookieOptions());
  return response;
}
