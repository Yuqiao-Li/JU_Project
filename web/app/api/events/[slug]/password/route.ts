import { NextResponse, type NextRequest } from "next/server";

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
 * SCOPE: this handler only verifies + rate-limits. Minting the short-lived signed
 * credential cookie that lets subsequent reads skip the bcrypt re-check is task 2.5;
 * it builds on this endpoint. The verify itself is the existing SECURITY DEFINER
 * `verify_event_password` (real bcrypt), called through the trusted role.
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

  return NextResponse.json({ ok: data === true });
}
