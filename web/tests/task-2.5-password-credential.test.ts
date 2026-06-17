import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PASSWORD_CREDENTIAL_TTL_SECONDS,
  passwordCookieName,
  signPasswordCredential,
  verifyPasswordCredential,
} from "../lib/events/password-credential";
import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 2.5 — password protection: the short-lived SIGNED CREDENTIAL (D7⑤/amend).
 *
 * The new surface for 2.5 is the credential a guest gets AFTER `verify_event_password`
 * succeeds, so that reloads/polls reveal the (first-tier) façade WITHOUT re-running
 * bcrypt — "读/轮询不再重哈希". Two layers are exercised here:
 *
 *  1. The credential itself (pure HMAC, `lib/events/password-credential.ts`). Asserted
 *     directly because it is dependency-free crypto — no DB, no Next, no `server-only`.
 *     A credential must: round-trip for the SAME slug+secret; be scoped to its slug (a
 *     credential for event A does NOT unlock event B); expire; reject tampering; and —
 *     the 禁止 line "密码不得明文存/传" — carry NO plaintext password (it can't: signing
 *     takes only slug+expiry+secret).
 *
 *  2. The DB honouring a TRUSTED "already verified" signal. `get_event_by_slug` gains a
 *     `password_verified` arg that is honoured ONLY for the trusted service-role SSR
 *     path (the one that validates the cookie). Mirrors TEST-SPEC §1.5a "持…凭证 →
 *     正常分级": with the verified flag the locked façade resolves to normal tiering with
 *     NO password re-hash; without it the gate still holds; and an anon caller passing
 *     the same flag is ignored (it can never self-grant). Asserted at the RPC boundary
 *     (the SSR HTML is a strict subset of this payload — same rationale as task 2.4a).
 */

// ── 1) The credential crypto (always runs — no DB) ───────────────────────────────
describe("task 2.5: password credential (signed, scoped, expiring HMAC)", () => {
  const SECRET = "t25-test-signing-secret-do-not-reuse";
  const SLUG_A = "t25-event-alpha-x7k2m9qpvw";
  const SLUG_B = "t25-event-bravo-q3w8z1n5rt";
  const NOW = 1_900_000_000_000; // fixed clock so expiry is deterministic

  it("round-trips: a credential signed for a slug verifies for that same slug", () => {
    const cred = signPasswordCredential(SLUG_A, SECRET, { nowMs: NOW });
    expect(verifyPasswordCredential(SLUG_A, cred, SECRET, { nowMs: NOW })).toBe(true);
  });

  it("is SLUG-SCOPED: a credential for event A does not unlock event B", () => {
    const cred = signPasswordCredential(SLUG_A, SECRET, { nowMs: NOW });
    expect(verifyPasswordCredential(SLUG_B, cred, SECRET, { nowMs: NOW })).toBe(false);
  });

  it("is SECRET-bound: a credential signed under another secret fails", () => {
    const cred = signPasswordCredential(SLUG_A, "some-other-secret", { nowMs: NOW });
    expect(verifyPasswordCredential(SLUG_A, cred, SECRET, { nowMs: NOW })).toBe(false);
  });

  it("EXPIRES: a credential is rejected once its TTL has elapsed", () => {
    const cred = signPasswordCredential(SLUG_A, SECRET, { nowMs: NOW, ttlSeconds: 60 });
    // Still valid inside the window…
    expect(verifyPasswordCredential(SLUG_A, cred, SECRET, { nowMs: NOW + 30_000 })).toBe(true);
    // …rejected once past it (短时凭证).
    expect(verifyPasswordCredential(SLUG_A, cred, SECRET, { nowMs: NOW + 61_000 })).toBe(false);
    expect(PASSWORD_CREDENTIAL_TTL_SECONDS).toBeGreaterThan(0);
  });

  it("rejects TAMPERING and malformed/empty tokens", () => {
    const cred = signPasswordCredential(SLUG_A, SECRET, { nowMs: NOW });
    const parts = cred.split(".");
    expect(parts.length).toBe(3);
    // Flip the MAC → must not verify.
    const forgedMac = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${parts[2].endsWith("A") ? "B" : "A"}`;
    expect(verifyPasswordCredential(SLUG_A, forgedMac, SECRET, { nowMs: NOW })).toBe(false);
    // Extend the expiry without re-signing → MAC no longer matches.
    const forgedExp = `${parts[0]}.${Number(parts[1]) + 999_999}.${parts[2]}`;
    expect(verifyPasswordCredential(SLUG_A, forgedExp, SECRET, { nowMs: NOW })).toBe(false);
    // Junk inputs.
    expect(verifyPasswordCredential(SLUG_A, "", SECRET, { nowMs: NOW })).toBe(false);
    expect(verifyPasswordCredential(SLUG_A, "not-a-token", SECRET, { nowMs: NOW })).toBe(false);
    expect(verifyPasswordCredential(SLUG_A, null, SECRET, { nowMs: NOW })).toBe(false);
    expect(verifyPasswordCredential(SLUG_A, undefined, SECRET, { nowMs: NOW })).toBe(false);
  });

  it("carries NO plaintext password and never echoes the secret (密码不得明文存/传)", () => {
    // Signing takes ONLY slug + secret + expiry — there is no password input at all,
    // so a credential structurally cannot contain a password. Also assert it never
    // leaks the raw secret.
    const cred = signPasswordCredential(SLUG_A, SECRET, { nowMs: NOW });
    expect(cred).not.toContain(SECRET);
    expect(cred).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
  });

  it("derives a per-slug cookie name so distinct events don't clobber each other", () => {
    expect(passwordCookieName(SLUG_A)).not.toBe(passwordCookieName(SLUG_B));
    // RFC 6265 cookie-name token: no separators/spaces.
    expect(passwordCookieName(SLUG_A)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ── 2) The DB honouring the trusted verified signal (needs the local stack) ──────
const LOCAL_UP = localStackRunning();
const FN = "get_event_by_slug";

function runSql(sql: string): string {
  const cfg = resolveLocalSupabase({ autoStart: false });
  if (!cfg) throw new Error("local supabase stack not reachable");
  return execFileSync("psql", [cfg.dbUrl, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type ApiResult = { data: unknown; error: unknown };
type EventObj = Record<string, unknown> | null;

function hasKey(obj: EventObj, key: string): boolean {
  return obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

describe("task 2.5: get_event_by_slug honours the trusted password_verified signal", () => {
  const i = infra();
  const hostA = i.hosts[0];

  const PREFIX = "t25";
  const SLUG_PWD = "t25-password-public";
  const SLUG_PWD_PRIV = "t25-password-private";
  const SENTINEL_ADDR = "t25-FULL-ADDRESS-77-Secret-Way-SENTINEL";
  const CITY = "t25-Brooklyn";
  const PASSWORD = "t25-correct-horse";
  const T_GOING = "25a00000-0000-4000-8000-000000000001";

  function anon(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  function service(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.serviceRoleKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async function callSlug(
    client: SupabaseClient,
    slug: string,
    opts: { token?: string; password?: string; passwordVerified?: boolean } = {},
  ): Promise<{ res: ApiResult; data: EventObj }> {
    const body: Record<string, unknown> = { slug };
    if (opts.token !== undefined) body.guest_token = opts.token;
    if (opts.password !== undefined) body.password = opts.password;
    if (opts.passwordVerified !== undefined) body.password_verified = opts.passwordVerified;
    const res = (await client.rpc(FN, body)) as ApiResult;
    return { res, data: (res.data as EventObj) ?? null };
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session").toBeTruthy();

    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    runSql(
      `insert into public.profiles (id, display_name) values ('${hostA.id}', 't25 host')
         on conflict (id) do nothing;`,
    );
    runSql(
      `insert into public.events
         (host_id, slug, title, description, cover_image_url, visibility, status,
          capacity, location_text, location_city) values
         ('${hostA.id}','${SLUG_PWD}','t25 Password Public','pwd desc','https://cover/p.png','public','published',10,'${SENTINEL_ADDR}','${CITY}'),
         ('${hostA.id}','${SLUG_PWD_PRIV}','t25 Password Private','pwd priv','https://cover/pp.png','private','published',10,'${SENTINEL_ADDR}','${CITY}');`,
    );
    // Real bcrypt hash on both (the gate must actually hash, not stub).
    runSql(
      `update public.events
         set view_password_hash = extensions.crypt('${PASSWORD}', extensions.gen_salt('bf', 12))
         where slug in ('${SLUG_PWD}','${SLUG_PWD_PRIV}');`,
    );
    // A real going guest on the public password event, to prove credential + RSVP token
    // together reveal the second tier on a reload.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name)
         values ((select id from public.events where slug='${SLUG_PWD}'), '${T_GOING}'::uuid, 't25 going');`,
    );
    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id, 'going', 0 from public.guests g where g.guest_token='${T_GOING}'::uuid;`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  it.skipIf(!LOCAL_UP)(
    "trusted service role + password_verified=true ⇒ normal tiering with NO bcrypt re-hash (持凭证 → 正常分级)",
    async () => {
      // The cookie-validated SSR/poll path: no plaintext password supplied, yet the
      // façade unlocks past the password gate because the trusted layer asserts it.
      const { res, data } = await callSlug(service(), SLUG_PWD, { passwordVerified: true });
      expect(res.error, JSON.stringify(res.error)).toBeNull();
      expect(data?.locked, "verified credential ⇒ not locked").toBe(false);
      expect(data?.requires_password, "still flagged as a password event").toBe(true);
      // First-tier façade resumes (public ⇒ count shown); password unlocks the poster,
      // not the address — second tier still needs an RSVP token.
      expect(hasKey(data, "going_count"), "count shown past the lock").toBe(true);
      expect(hasKey(data, "location_text"), "no address without an RSVP token").toBe(false);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "service role WITHOUT the verified signal ⇒ still the locked façade (no plain SSR leak)",
    async () => {
      const { data } = await callSlug(service(), SLUG_PWD);
      expect(data?.locked, "no credential, no password ⇒ locked").toBe(true);
      expect(hasKey(data, "location_text"), "locked ⇒ no address key").toBe(false);
      expect(JSON.stringify(data), "locked ⇒ no address sentinel").not.toContain(SENTINEL_ADDR);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "anon passing password_verified=true is IGNORED ⇒ stays locked (cannot self-grant)",
    async () => {
      // The verified flag is honoured ONLY for service_role. An attacker setting it on a
      // direct anon RPC call gets nothing extra.
      const { data } = await callSlug(anon(), SLUG_PWD, { passwordVerified: true });
      expect(data?.locked, "anon cannot bypass the password gate by claiming verified").toBe(true);
      expect(hasKey(data, "location_text")).toBe(false);
      expect(JSON.stringify(data)).not.toContain(SENTINEL_ADDR);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "verified credential + a going RSVP token ⇒ full second tier (address) on the reload",
    async () => {
      const { data } = await callSlug(service(), SLUG_PWD, {
        passwordVerified: true,
        token: T_GOING,
      });
      expect(data?.locked, "credential ⇒ unlocked façade").toBe(false);
      expect(data?.unlocked, "going token ⇒ second tier").toBe(true);
      expect(data?.location_text, "address revealed for a verified + RSVP'd guest").toBe(SENTINEL_ADDR);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "private + password: anon still NULL; trusted role + verified ⇒ tiered façade",
    async () => {
      const an = await callSlug(anon(), SLUG_PWD_PRIV, { passwordVerified: true });
      expect(an.data, "anon never reads a private event, verified flag or not").toBeNull();

      const ssr = await callSlug(service(), SLUG_PWD_PRIV, { passwordVerified: true });
      expect(ssr.data, "trusted SSR resolves the private password event with a credential").not.toBeNull();
      expect(ssr.data?.locked, "credential ⇒ past the password gate").toBe(false);
      expect(ssr.data?.title).toBe("t25 Password Private");
    },
  );
});
