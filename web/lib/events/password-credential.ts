import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived SIGNED CREDENTIAL for password-protected events (task 2.5, D7⑤/amend).
 *
 * WHY THIS EXISTS. A guest unlocks a password event once via `verify_event_password`
 * (one bcrypt). To then reload the page or poll for live data WITHOUT re-running bcrypt
 * on every read ("不得每次读重跑 bcrypt"), the server hands back a credential: an
 * HMAC-signed `v1.<exp>.<mac>` string stored in an HttpOnly cookie. On later reads the
 * trusted server validates the (cheap) HMAC and tells the DB the password is satisfied
 * via `get_event_by_slug(..., password_verified => true)` — honoured ONLY for the
 * service-role SSR path, so an attacker can never self-grant.
 *
 * SECURITY PROPERTIES (asserted in tests/task-2.5-password-credential.test.ts):
 *  - SLUG-SCOPED: the MAC binds the slug, so a credential for event A can't unlock B.
 *  - EXPIRING: the expiry is inside the signed message, so it can't be extended without
 *    re-signing; verification rejects anything past `exp` (短时凭证).
 *  - TAMPER-EVIDENT: a constant-time MAC compare rejects any forged expiry/mac.
 *  - NO PLAINTEXT: signing takes ONLY slug + expiry + secret — there is no password
 *    input, so a credential structurally cannot carry the password ("密码不得明文存/传").
 *
 * This module is deliberately dependency-free (just `node:crypto`) and does NOT import
 * `server-only`: the pure sign/verify take the secret as an argument so they're unit
 * testable, while `credentialSecret()` reads the trusted secret lazily from the
 * environment (never at import time, so `next build` without secrets never throws).
 */

/** Domain-separation tag so this HMAC use can't collide with any other use of the key. */
const CONTEXT = "event-password-credential:v1";

/** Credential lifetime. Short by design — a stolen cookie is only briefly useful. */
export const PASSWORD_CREDENTIAL_TTL_SECONDS = 2 * 60 * 60; // 2 hours

interface SignOptions {
  /** Override "now" (epoch ms) — tests pin a clock; production omits it. */
  nowMs?: number;
  /** Override the TTL (seconds). */
  ttlSeconds?: number;
}

interface VerifyOptions {
  /** Override "now" (epoch ms) — tests pin a clock; production omits it. */
  nowMs?: number;
}

/** base64url-encoded HMAC-SHA256 over the domain tag + slug + expiry. */
function computeMac(slug: string, expSeconds: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${CONTEXT}|${slug}|${expSeconds}`)
    .digest("base64url");
}

/**
 * Mint a credential proving the holder satisfied `slug`'s password until `exp`.
 * Format: `v1.<expEpochSeconds>.<base64urlMac>`.
 */
export function signPasswordCredential(slug: string, secret: string, opts: SignOptions = {}): string {
  const nowMs = opts.nowMs ?? Date.now();
  const ttl = opts.ttlSeconds ?? PASSWORD_CREDENTIAL_TTL_SECONDS;
  const exp = Math.floor(nowMs / 1000) + ttl;
  return `v1.${exp}.${computeMac(slug, exp, secret)}`;
}

/**
 * True iff `token` is an unexpired, untampered credential for `slug` under `secret`.
 * Any malformed/forged/expired/cross-slug token returns false (fail closed).
 */
export function verifyPasswordCredential(
  slug: string,
  token: string | null | undefined,
  secret: string,
  opts: VerifyOptions = {},
): boolean {
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, expStr, mac] = parts;
  if (version !== "v1") return false;

  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp <= 0) return false;

  const nowMs = opts.nowMs ?? Date.now();
  if (exp * 1000 <= nowMs) return false; // expired

  // Constant-time compare against the recomputed MAC (binds slug + exp + secret).
  const expected = computeMac(slug, exp, secret);
  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/**
 * The trusted secret used to sign/verify credentials. Server-only in practice (callers
 * are Route Handlers / the SSR page). Prefers a dedicated `EVENT_CREDENTIAL_SECRET`,
 * else falls back to the service-role key — already a required server secret, so
 * password events need no extra configuration. Read lazily so importing this module
 * (e.g. for the unit tests, or during `next build`) never requires the secret.
 */
export function credentialSecret(): string {
  const secret = process.env.EVENT_CREDENTIAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error(
      "Missing EVENT_CREDENTIAL_SECRET (or SUPABASE_SERVICE_ROLE_KEY) for signing event password credentials.",
    );
  }
  return secret;
}

/**
 * Per-slug cookie name so unlocking event A never clobbers event B's credential. Slugs
 * are `[a-z0-9-]` (slugify + base62 suffix), all valid RFC 6265 cookie-name characters.
 */
export function passwordCookieName(slug: string): string {
  return `evpw_${slug}`;
}

/** Cookie attributes for the credential: HttpOnly, short-lived, same-site, HTTPS in prod. */
export function passwordCredentialCookieOptions(maxAgeSeconds: number = PASSWORD_CREDENTIAL_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
