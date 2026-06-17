import "server-only";

import { headers as nextHeaders } from "next/headers";

/**
 * Real client-IP resolution for read-side rate limiting (task 2.3.5, D14).
 *
 * On Vercel the platform injects `x-real-ip` (the true client IP) and prepends it
 * to `x-forwarded-for`; both are trustworthy because the edge OVERWRITES whatever
 * a client tried to spoof. We prefer `x-real-ip`, then the first hop of
 * `x-forwarded-for`, then Vercel's `x-vercel-forwarded-for`.
 *
 * CRITICAL (task 禁止: "不得因取不到 IP 形同虚设"): when no IP can be resolved we do
 * NOT skip rate limiting — that would make the limiter useless and hand an attacker
 * unlimited reads simply by stripping the header. Instead every IP-less request
 * shares ONE bucket (`UNKNOWN_IP`), so they are throttled in aggregate.
 */

/** Shared bucket for requests with no resolvable IP — never an escape hatch. */
export const UNKNOWN_IP = "ip:unknown";

/**
 * Pure header → IP resolver. Takes a `Headers` object so it is trivially testable
 * (and usable from both Route Handlers via `request.headers` and SSR via
 * `clientIp()` below) without reaching into framework request state.
 */
export function ipFromHeaders(headers: Headers): string {
  const realIp = headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const vercel = headers.get("x-vercel-forwarded-for");
  if (vercel) {
    const first = vercel.split(",")[0]?.trim();
    if (first) return first;
  }

  return UNKNOWN_IP;
}

/** SSR convenience: resolve the caller's IP from the incoming request headers. */
export async function clientIp(): Promise<string> {
  return ipFromHeaders(await nextHeaders());
}
