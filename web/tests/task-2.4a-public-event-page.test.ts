import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 2.4a [SECURITY] — public event page SSR + strict tiering + private
 * convergence + password gate (TEST-SPEC §2.4). Written by the INDEPENDENT test
 * agent (never wrote the implementation) with the stance "assume the page
 * over-shares".
 *
 * WHY THESE ASSERTIONS ARE AT THE RPC BOUNDARY, NOT THE RENDERED HTML.
 * The SSR page (`web/app/[slug]/page.tsx`) and the poll/password Route Handlers
 * read an event in exactly ONE way: through the TRUSTED service-role client
 * calling `get_event_by_slug` (see `lib/events/read-event.ts`). The page passes
 * NO guest_token at SSR (the token is client-only / localStorage), then hands the
 * returned façade to `<EventView>`, which can only render fields the façade
 * already carries (it gates the full address on `unlocked` and re-reads with the
 * token from the browser). Therefore the SSR HTML is a strict SUBSET of this RPC
 * payload — a field/value that is ABSENT here can never appear in the page body,
 * and an oracle that is present here is the page's real exposure. Asserting on the
 * payload the trusted role returns is thus STRICTER than grepping HTML (it also
 * catches keys the renderer happens not to print today), and is what TEST-SPEC
 * §2.4 bullet 1 asks for ("断言无 `location_text` 键 …… 而非对 HTML grep 地址串").
 * Each test that maps to "SSR 响应体" reproduces the page's own call:
 * service-role `get_event_by_slug` with no token (the SSR render) vs. with the
 * guest's token (the client poll re-read after RSVP).
 *
 * The roles are real PostgREST paths because the private gate keys on
 * `auth.role()`: `service()` is the trusted SSR path; `anon()` is the bypass an
 * attacker would try (calling the RPC directly to skip SSR). Seeding is done as
 * the postgres superuser (psql) since anon/service hold no direct table grant —
 * same pattern as the 1.5a / 1.5b suites. Gated on a reachable local stack so the
 * file skips green without Docker; where the stack IS up the gate must hold.
 *
 * Coverage vs TEST-SPEC §2.4:
 *   • 结构断言 — un-unlocked `get_event_by_slug` returns NO `location_text` key.
 *   • sentinel — the seed address is a unique sentinel; the SSR payload (no token)
 *     never contains it; the post-RSVP re-read (with token) does.
 *   • full capacity ⇒ the page-feeding façade reports a full house AND a fresh
 *     `submit_rsvp` lands `waitlisted` (record), not `going`.
 *   • guest_token never appears in any shareable surface (the SSR/unlocked payload
 *     bodies) — it lives only in the submit_rsvp return value + localStorage.
 *   • anon calling a PRIVATE event's RPC directly (bypassing SSR) is refused.
 *   • password event ⇒ minimal locked façade (drives the password box); a correct
 *     password (verify_event_password) resumes normal tiering, a wrong one stays
 *     locked, and the locked façade leaks no second/third tier.
 */
const LOCAL_UP = localStackRunning();

const FN = "get_event_by_slug";
const FN_PW = "verify_event_password";
const FN_RSVP = "submit_rsvp";

/** Run SQL as the postgres superuser (bypasses grants/RLS). Throws on SQL error. */
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

// ── Fixtures (prefix t24a so they never collide with the demo seed or 1.5a's t15a).
const PREFIX = "t24a";
const SLUG_PUB = "t24a-public-open"; // public, count shown, has a going + a not_going guest
const SLUG_RSVP = "t24a-rsvp-e2e"; // public, no pre-seeded guests — true submit→unlock e2e
const SLUG_FULL = "t24a-full-house"; // public, capacity 1, one going seat taken (waitlist case)
const SLUG_PRIV = "t24a-private"; // private, published (convergence: SSR-only)
const SLUG_PWD = "t24a-password"; // public + password (drives the password box)

const SENTINEL_ADDR = "t24a-FULL-ADDRESS-9-Hidden-Court-SENTINEL"; // location_text (2nd tier)
const SENTINEL_URL = "https://t24a-venue-secret.invalid/map"; // location_url (2nd tier)
const SENTINEL_CONTACT = "t24a-contact-secret@sentinel.invalid"; // 3rd tier — NEVER appears
const CITY = "t24a-Queens"; // location_city (1st tier — MAY appear)
const PASSWORD = "t24a-correct-horse-battery";
const WRONG_PASSWORD = "t24a-wrong-password";

// Deterministic guest tokens so cross-event / decliner probes are reproducible.
const T_GOING = "24a00000-0000-4000-8000-000000000001"; // PUB, going, has sentinel contact
const T_NOTGOING = "24a00000-0000-4000-8000-000000000002"; // PUB, not_going (a decliner)
const T_FULL = "24a00000-0000-4000-8000-000000000003"; // FULL, going (occupies the only seat)
const T_PRIV = "24a00000-0000-4000-8000-000000000004"; // PRIV, going (valid unlock — still null to anon)

/** Own-key check that doesn't trip on inherited props — used for "key OMITTED". */
function hasKey(obj: EventObj, key: string): boolean {
  return obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Third-tier fields must never appear in ANY returned shape (D7② 第三类). */
function assertNoThirdTier(data: EventObj, label: string): void {
  const json = JSON.stringify(data ?? {});
  expect(json, `${label}: host-only contact must never ride along`).not.toContain(SENTINEL_CONTACT);
  expect(hasKey(data, "contact"), `${label}: contact must never be a key`).toBe(false);
  expect(hasKey(data, "view_password_hash"), `${label}: raw hash must never leak`).toBe(false);
  expect(hasKey(data, "guest_token"), `${label}: no guest_token in the read path`).toBe(false);
  expect(hasKey(data, "user_id"), `${label}: no guest user_id in the read path`).toBe(false);
}

describe("task 2.4a [SECURITY]: public event page SSR + tiering + private + password (TEST-SPEC §2.4)", () => {
  const i = infra();
  const hostA = i.hosts[0];

  function anon(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  /** The TRUSTED SSR path — the page/route's service-role client. */
  function service(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.serviceRoleKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** Reproduce the page/route read: get_event_by_slug; omit token/password to null them. */
  async function callSlug(
    client: SupabaseClient,
    slug: string,
    opts: { token?: string; password?: string } = {},
  ): Promise<{ res: ApiResult; data: EventObj }> {
    const body: Record<string, unknown> = { slug };
    if (opts.token !== undefined) body.guest_token = opts.token;
    if (opts.password !== undefined) body.password = opts.password;
    const res = (await client.rpc(FN, body)) as ApiResult;
    return { res, data: (res.data as EventObj) ?? null };
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);

    // Host profile is auto-created by the auth.users trigger; upsert defensively.
    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't24a host A')
         on conflict (id) do nothing;`,
    );

    // Events. All carry the SAME sentinel address/url/city so a leak is unambiguous.
    runSql(
      `insert into public.events
         (host_id, slug, title, description, cover_image_url, visibility, status,
          capacity, location_text, location_url, location_city, hide_guest_count) values
         ('${hostA.id}','${SLUG_PUB}','t24a Public Open','public desc','https://cover/pub.png','public','published',10,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false),
         ('${hostA.id}','${SLUG_RSVP}','t24a RSVP E2E','rsvp desc','https://cover/rsvp.png','public','published',10,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false),
         ('${hostA.id}','${SLUG_FULL}','t24a Full House','full desc','https://cover/full.png','public','published',1,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false),
         ('${hostA.id}','${SLUG_PRIV}','t24a Private','private desc','https://cover/priv.png','private','published',5,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false),
         ('${hostA.id}','${SLUG_PWD}','t24a Password','pwd desc','https://cover/pwd.png','public','published',8,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false);`,
    );

    // Real bcrypt hash on the password event — verify_event_password / the page must
    // reproduce it, proving the gate actually hashes (not a stub).
    runSql(
      `update public.events
         set view_password_hash = extensions.crypt('${PASSWORD}', extensions.gen_salt('bf', 12))
         where slug = '${SLUG_PWD}';`,
    );

    // Guests: a going (with sentinel contact) + a not_going decliner on PUB; a going
    // that fills FULL's single seat; a going on PRIV (a *valid* unlock, to prove it
    // still can't bypass the private role gate for anon).
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact) values
         ((select id from public.events where slug='${SLUG_PUB}'),  '${T_GOING}'::uuid,    't24a going',    '${SENTINEL_CONTACT}'),
         ((select id from public.events where slug='${SLUG_PUB}'),  '${T_NOTGOING}'::uuid, 't24a notgoing', null),
         ((select id from public.events where slug='${SLUG_FULL}'), '${T_FULL}'::uuid,     't24a full go',  null),
         ((select id from public.events where slug='${SLUG_PRIV}'), '${T_PRIV}'::uuid,     't24a priv go',  null);`,
    );

    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_GOING}'::uuid    then 'going'
             when '${T_NOTGOING}'::uuid then 'not_going'
             when '${T_FULL}'::uuid     then 'going'
             when '${T_PRIV}'::uuid     then 'going'
           end,
           0
         from public.guests g
         where g.guest_token in ('${T_GOING}'::uuid,'${T_NOTGOING}'::uuid,'${T_FULL}'::uuid,'${T_PRIV}'::uuid);`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  // ── §2.4 结构断言 + sentinel — the SSR render (trusted role, NO token) is first-tier ──
  it.skipIf(!LOCAL_UP)(
    "SSR read (service role, no token) returns the façade with NO location_text key and never the address sentinel",
    async () => {
      // Exactly what page.tsx does: readEventBySlug(slug) → service.rpc(get_event_by_slug)
      // with guest_token undefined. This payload is a SUPERSET of the SSR HTML.
      const { res, data } = await callSlug(service(), SLUG_PUB);
      expect(res.error, JSON.stringify(res.error)).toBeNull();
      expect(data, "public event returns a façade for SSR").not.toBeNull();

      // Structural (TEST-SPEC §2.4 bullet 1): the address keys are OMITTED, not nulled.
      expect(data?.unlocked, "no token at SSR ⇒ not unlocked").toBe(false);
      expect(hasKey(data, "location_text"), "未解锁 ⇒ location_text 键被省略").toBe(false);
      expect(hasKey(data, "location_url"), "未解锁 ⇒ location_url 键被省略").toBe(false);

      // Sentinel: the full address cannot be anywhere in the SSR payload ⇒ cannot be in
      // the SSR HTML body (the renderer only prints façade fields, gated on `unlocked`).
      const json = JSON.stringify(data);
      expect(json, "未RSVP 的 SSR 响应体不含地址 sentinel").not.toContain(SENTINEL_ADDR);
      expect(json, "未RSVP 的 SSR 响应体不含地图 URL sentinel").not.toContain(SENTINEL_URL);

      // First tier IS present — proves tiering is field-level, not all-or-nothing.
      expect(data?.title).toBe("t24a Public Open");
      expect(data?.location_city, "city-level is first tier (rendered)").toBe(CITY);
      assertNoThirdTier(data, "ssr-facade");
    },
  );

  // ── §2.4 更狠 — a DECLINER's real token must not reveal the address on SSR re-read ──
  it.skipIf(!LOCAL_UP)(
    "a not_going token (a real decline) does NOT unlock the address on the SSR/poll re-read",
    async () => {
      // The client poll path relays the guest's token; a not_going RSVP is NOT in the
      // unlock set, so the address must stay hidden.
      const { data } = await callSlug(service(), SLUG_PUB, { token: T_NOTGOING });
      expect(data?.unlocked, "not_going must not unlock").toBe(false);
      expect(hasKey(data, "location_text"), "decliner ⇒ no address key").toBe(false);
      expect(JSON.stringify(data), "decliner ⇒ no address sentinel").not.toContain(SENTINEL_ADDR);
    },
  );

  // ── §2.4 sentinel — completing an RSVP unlocks the address on the re-read ────────────
  it.skipIf(!LOCAL_UP)(
    "after a real submit_rsvp the token-bearing re-read DOES return location_text (the sentinel appears)",
    async () => {
      const an = anon();

      // Before RSVP: the SSR render of this slug carries no address.
      const before = await callSlug(service(), SLUG_RSVP);
      expect(before.data?.unlocked, "pre-RSVP ⇒ locked").toBe(false);
      expect(JSON.stringify(before.data), "pre-RSVP SSR body has no sentinel").not.toContain(SENTINEL_ADDR);

      // Guest RSVPs via the anon write RPC (no account, no token yet) — the real flow.
      const submit = (await an.rpc(FN_RSVP, {
        slug: SLUG_RSVP,
        display_name: "t24a fresh guest",
        status: "going",
      })) as ApiResult;
      expect(submit.error, JSON.stringify(submit.error)).toBeNull();
      const minted = submit.data as Record<string, unknown> | null;
      expect(minted?.status, "a non-full event accepts the RSVP as going").toBe("going");

      // submit_rsvp is the ONE legitimate place a token is returned (to store in
      // localStorage). It must be a real token we can then unlock with.
      const token = minted?.guest_token;
      expect(typeof token, "submit_rsvp returns the guest's own token").toBe("string");

      // The client re-reads with that token (poll route ?token=…): now the address is in.
      const after = await callSlug(service(), SLUG_RSVP, { token: token as string });
      expect(after.data?.unlocked, "post-RSVP ⇒ unlocked").toBe(true);
      expect(after.data?.location_text, "完成 RSVP 后 ⇒ 返回 location_text").toBe(SENTINEL_ADDR);
      expect(after.data?.location_url).toBe(SENTINEL_URL);
      assertNoThirdTier(after.data, "post-rsvp-unlocked");
    },
  );

  // ── §2.4 — guest_token never appears in any shareable surface (URL / SSR/unlocked body) ──
  it.skipIf(!LOCAL_UP)(
    "the read path never echoes a guest_token into a shareable response body (locked OR unlocked)",
    async () => {
      // The SSR render uses no token and must not surface anyone's token.
      const ssr = await callSlug(service(), SLUG_PUB);
      expect(hasKey(ssr.data, "guest_token"), "no guest_token key in the SSR body").toBe(false);
      expect(JSON.stringify(ssr.data), "no guest token value in the SSR body").not.toContain(T_GOING);

      // Even the UNLOCKED re-read (which is GIVEN the token as input) must not REFLECT it
      // back into the body — a body is shareable, the input is not.
      const unlocked = await callSlug(service(), SLUG_PUB, { token: T_GOING });
      expect(unlocked.data?.unlocked, "going token unlocks").toBe(true);
      expect(hasKey(unlocked.data, "guest_token"), "unlocked body still has no token key").toBe(false);
      expect(JSON.stringify(unlocked.data), "unlocked body does not echo the token").not.toContain(T_GOING);
    },
  );

  // ── §2.4 — anon calling a PRIVATE event's RPC directly (bypassing SSR) is refused ────
  it.skipIf(!LOCAL_UP)(
    "private event: anon get_event_by_slug ⇒ NULL (the function refuses); only the trusted SSR role resolves it",
    async () => {
      // The attacker skips the SSR layer and hits the RPC with the anon key. The
      // DATABASE turns them away — the convergence is physical, not "SSR won't call".
      const an = await callSlug(anon(), SLUG_PRIV);
      expect(an.res.error, JSON.stringify(an.res.error)).toBeNull();
      expect(an.data, "anon must get NULL for a private slug (no façade, no existence oracle)").toBeNull();

      // 更狠: even WITH a genuinely-unlocking token, anon still gets null — the private
      // role gate precedes (and is independent of) the unlock gate.
      const anTok = await callSlug(anon(), SLUG_PRIV, { token: T_PRIV });
      expect(anTok.data, "a valid token must NOT bypass the private role gate for anon").toBeNull();

      // 更狠: anon cannot read the private event off the base table either (no anon
      // policy/grant) — so there is no side door around the RPC.
      const direct = (await anon().from("events").select("slug").eq("slug", SLUG_PRIV)) as ApiResult;
      const rows = (direct.data as unknown[] | null) ?? [];
      expect(
        direct.error !== null || rows.length === 0,
        "anon direct SELECT on a private event must be empty/denied",
      ).toBe(true);

      // The trusted SSR path DOES resolve it (private 只走 SSR 受信角色).
      const ssr = await callSlug(service(), SLUG_PRIV);
      expect(ssr.data, "service_role (SSR) may read a private event").not.toBeNull();
      expect(ssr.data?.title).toBe("t24a Private");
      // Private + not-unlocked ⇒ the count oracle is omitted too (D7②).
      expect(hasKey(ssr.data, "going_count"), "private+locked ⇒ count key omitted").toBe(false);
      assertNoThirdTier(ssr.data, "private-ssr-facade");
    },
  );

  // ── §2.4 — capacity full ⇒ the page-feeding façade is full AND a fresh RSVP waitlists ──
  it.skipIf(!LOCAL_UP)(
    "a full event: the SSR façade reports a full house and a new submit_rsvp is recorded waitlisted (not going)",
    async () => {
      // The page renders "Full — join the waitlist" off this façade: capacity 1, the
      // single seat already taken ⇒ remaining 0.
      const facade = await callSlug(service(), SLUG_FULL);
      expect(facade.data?.going_count, "one going seat occupied").toBe(1);
      expect(facade.data?.capacity_remaining, "capacity 1 − occupancy 1 ⇒ 0 (full)").toBe(0);

      // A new guest RSVPs going on a full event ⇒ the record is forced to waitlisted.
      const submit = (await anon().rpc(FN_RSVP, {
        slug: SLUG_FULL,
        display_name: "t24a overflow guest",
        status: "going",
      })) as ApiResult;
      expect(submit.error, JSON.stringify(submit.error)).toBeNull();
      const minted = submit.data as Record<string, unknown> | null;
      expect(minted?.status, "full ⇒ the confirmed status is waitlisted, not going").toBe("waitlisted");
      expect(minted?.waitlisted, "the waitlisted flag is set").toBe(true);

      // The waitlisted guest does NOT consume a seat — the façade stays full.
      const after = await callSlug(service(), SLUG_FULL);
      expect(after.data?.going_count, "a waitlisted RSVP does not increase going_count").toBe(1);
      expect(after.data?.capacity_remaining, "still full after the waitlisted RSVP").toBe(0);
    },
  );

  // ── §2.4 — password event ⇒ minimal locked façade (drives the password box) ──────────
  it.skipIf(!LOCAL_UP)(
    "password event: the SSR read with no password is the minimal locked façade (title/cover only, no 2nd/3rd tier)",
    async () => {
      // This is what the page hands to <PasswordGate>: locked=true + just enough to
      // render the box / share preview, and NOTHING sensitive behind the lock — even on
      // the trusted SSR path (service_role does NOT bypass the password gate).
      const locked = await callSlug(service(), SLUG_PWD);
      expect(locked.res.error, JSON.stringify(locked.res.error)).toBeNull();
      expect(locked.data, "password event still returns a locked façade").not.toBeNull();
      expect(locked.data?.locked, "locked=true ⇒ render the password box").toBe(true);
      expect(locked.data?.requires_password, "requires_password=true").toBe(true);
      expect(locked.data?.unlocked, "unlocked=false while locked").toBe(false);
      expect(locked.data?.title, "title present for the box/preview").toBe("t24a Password");
      expect(locked.data?.cover_image_url, "cover present for the share preview").toBe("https://cover/pwd.png");

      // No second tier, no occupancy oracle, no third tier behind the lock.
      expect(hasKey(locked.data, "location_text"), "NO address behind the lock").toBe(false);
      expect(hasKey(locked.data, "going_count"), "NO count behind the lock").toBe(false);
      expect(JSON.stringify(locked.data), "no address sentinel behind the lock").not.toContain(SENTINEL_ADDR);
      assertNoThirdTier(locked.data, "password-locked");
    },
  );

  it.skipIf(!LOCAL_UP)(
    "password gate: verify_event_password is real bcrypt; correct password resumes normal tiering, wrong stays locked",
    async () => {
      const an = anon();

      // The /password Route Handler verifies via verify_event_password BEFORE revealing
      // anything. Real bcrypt: correct ⇒ true, wrong ⇒ false (no loose match).
      const ok = (await an.rpc(FN_PW, { slug: SLUG_PWD, password: PASSWORD })) as ApiResult;
      expect(ok.error, JSON.stringify(ok.error)).toBeNull();
      expect(ok.data, "correct password ⇒ verify true").toBe(true);

      const bad = (await an.rpc(FN_PW, { slug: SLUG_PWD, password: WRONG_PASSWORD })) as ApiResult;
      expect(bad.data, "wrong password ⇒ verify false").toBe(false);

      // After a correct verify the route re-reads WITH the password: normal first-tier
      // façade resumes (count shown), but still NO address without an RSVP token — a
      // password unlocks the poster, not the second tier.
      const unlockedFacade = await callSlug(service(), SLUG_PWD, { password: PASSWORD });
      expect(unlockedFacade.data?.locked, "correct password ⇒ not locked").toBe(false);
      expect(unlockedFacade.data?.requires_password, "still flagged as a password event").toBe(true);
      expect(unlockedFacade.data?.unlocked, "password alone is not an RSVP unlock").toBe(false);
      expect(hasKey(unlockedFacade.data, "going_count"), "public ⇒ count shown past the lock").toBe(true);
      expect(hasKey(unlockedFacade.data, "location_text"), "no address without an RSVP token").toBe(false);
      assertNoThirdTier(unlockedFacade.data, "password-unlocked-facade");

      // A wrong password keeps the SSR read at the locked façade — no leak.
      const stillLocked = await callSlug(service(), SLUG_PWD, { password: WRONG_PASSWORD });
      expect(stillLocked.data?.locked, "wrong password ⇒ stays locked").toBe(true);
      expect(JSON.stringify(stillLocked.data), "wrong password ⇒ no sentinel").not.toContain(SENTINEL_ADDR);
    },
  );
});
