import "server-only";

import { NextResponse } from "next/server";

import type { RateLimitResult } from "./limiter";

/**
 * Turn a blocked rate-limit outcome into a standard `429 Too Many Requests`.
 *
 * Used by the read / poll / password Route Handlers:
 *   const limit = await rateLimit(quota, identifier);
 *   if (!limit.success) return rateLimitedResponse(limit);
 *
 * Emits `Retry-After` (seconds) plus the conventional `RateLimit-*` headers so a
 * well-behaved client can back off and align its polling to the window (D4).
 */
export function rateLimitedResponse(result: RateLimitResult): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: "rate_limited",
      message: "Too many requests — please slow down and try again shortly.",
      retry_after: retryAfter,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "RateLimit-Limit": String(result.limit),
        "RateLimit-Remaining": String(result.remaining),
        "RateLimit-Reset": String(retryAfter),
        "Cache-Control": "no-store",
      },
    },
  );
}
