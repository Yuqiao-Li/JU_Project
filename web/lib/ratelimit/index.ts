import "server-only";

/**
 * Read-side rate-limiting infrastructure (task 2.3.5). Server-only barrel.
 *
 * - `ipFromHeaders` / `clientIp` — resolve the real client IP (Vercel-aware), with
 *   a shared bucket fallback so a missing IP never disables limiting.
 * - `rateLimit` / `QUOTAS` — sliding-window limiter (Upstash, else in-memory).
 * - `rateLimitedResponse` — build the 429 for Route Handlers.
 */

export { ipFromHeaders, clientIp, UNKNOWN_IP } from "./ip";
export {
  rateLimit,
  resetMemoryRateLimits,
  QUOTAS,
  type QuotaName,
  type RateLimitResult,
} from "./limiter";
export { rateLimitedResponse } from "./guard";
