import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Read-side rate limiter (task 2.3.5, D4/D14) — the Next.js layer.
 *
 * WHY HERE AND NOT IN POSTGRES (task 禁止: "限流不得放 Postgres 读侧"): a read DoS
 * must be turned away before it reaches the database, so this lives at the edge /
 * Next layer backed by Upstash Redis (sliding window, keyed on the real client IP).
 * The WRITE path keeps its own DB-side `rate_limits` backstop (submit_rsvp /
 * add_comment / verify_event_password) so an attacker bypassing Next is still
 * limited — the two layers are complementary, not redundant.
 *
 * BACKENDS. Upstash is used when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
 * are configured. Otherwise — local dev, tests, or a Redis outage — we fall back to a
 * process-local in-memory sliding window. The limiter therefore ALWAYS enforces a
 * cap (never fails open / "形同虚设"); only its scope differs (per-instance vs.
 * global). Set `RATELIMIT_BACKEND=memory` to force the in-memory path (deterministic
 * tests without hitting a real Redis).
 */

export type QuotaName = "event_read" | "event_poll" | "password_attempt";

interface QuotaConfig {
  limit: number;
  windowSeconds: number;
}

/**
 * Quotas. `event_poll` is deliberately MUCH more generous than `event_read` so an
 * engaged poller (one that holds a guest_token) doing visibility-aware polling is
 * never falsely 429'd, while a fresh/anon read of a new slug gets the strict cap
 * that blunts scraping (D4: "已RSVP/受信轮询走更宽松配额、间隔对齐窗口").
 * `password_attempt` is tight to blunt brute force AND bcrypt-DoS (D7amend).
 */
export const QUOTAS: Record<QuotaName, QuotaConfig> = {
  event_read: { limit: 30, windowSeconds: 60 },
  event_poll: { limit: 120, windowSeconds: 60 },
  password_attempt: { limit: 8, windowSeconds: 300 },
};

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms at which the window resets (oldest counted hit ages out). */
  reset: number;
}

function upstashConfigured(): boolean {
  // Force the deterministic in-memory limiter when explicitly requested, or under
  // Vitest — a unit test must never depend on a network round-trip to (or stale
  // counters in) a real Redis. Production still uses Upstash whenever it's set.
  if (process.env.RATELIMIT_BACKEND === "memory" || process.env.VITEST) return false;
  return (
    !!process.env.UPSTASH_REDIS_REST_URL &&
    !!process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

let redisClient: Redis | null = null;
function redis(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL as string,
      token: process.env.UPSTASH_REDIS_REST_TOKEN as string,
    });
  }
  return redisClient;
}

const limiters = new Map<QuotaName, Ratelimit>();
function upstashLimiter(name: QuotaName): Ratelimit {
  let limiter = limiters.get(name);
  if (!limiter) {
    const cfg = QUOTAS[name];
    limiter = new Ratelimit({
      redis: redis(),
      limiter: Ratelimit.slidingWindow(cfg.limit, `${cfg.windowSeconds} s`),
      prefix: `rl:${name}`,
      analytics: false,
    });
    limiters.set(name, limiter);
  }
  return limiter;
}

// ── In-memory fallback (sliding-window log) ───────────────────────────────────
const memory = new Map<string, number[]>();

function memoryLimit(name: QuotaName, identifier: string): RateLimitResult {
  const cfg = QUOTAS[name];
  const windowMs = cfg.windowSeconds * 1000;
  const key = `${name}:${identifier}`;
  const now = Date.now();
  const cutoff = now - windowMs;

  const hits = (memory.get(key) ?? []).filter((t) => t > cutoff);
  const success = hits.length < cfg.limit;
  if (success) hits.push(now);
  memory.set(key, hits);

  const oldest = hits.length > 0 ? hits[0] : now;
  return {
    success,
    limit: cfg.limit,
    remaining: Math.max(0, cfg.limit - hits.length),
    reset: oldest + windowMs,
  };
}

/** Clear the in-memory limiter state. Intended for tests; a no-op against Upstash. */
export function resetMemoryRateLimits(): void {
  memory.clear();
}

/**
 * Count one hit against `name` for `identifier` and report whether it is allowed.
 * Falls back to the in-memory limiter if Upstash is unconfigured OR unreachable —
 * the cap is always enforced.
 */
export async function rateLimit(name: QuotaName, identifier: string): Promise<RateLimitResult> {
  if (upstashConfigured()) {
    try {
      const res = await upstashLimiter(name).limit(identifier);
      return {
        success: res.success,
        limit: res.limit,
        remaining: res.remaining,
        reset: res.reset,
      };
    } catch {
      // Redis unreachable: fall back to the in-memory limiter rather than failing
      // open. (The write path additionally has the DB rate_limits backstop.)
      return memoryLimit(name, identifier);
    }
  }
  return memoryLimit(name, identifier);
}
