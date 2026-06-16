import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.5a [SECURITY] — `get_event_by_slug` + `verify_event_password`, the single
 * public read path (migration 0007_get_event_by_slug.sql, logical "0005b";
 * TEST-SPEC §1.5a).
 *
 * Written by the INDEPENDENT test agent (never wrote the implementation) with the
 * stance "assume this function over-shares". `anon` has NO direct privilege on any
 * client-data table (0004/0005), so EVERY public/guest read of an event flows
 * through this one SECURITY DEFINER function — a single missing branch here leaks
 * the full address, the guest-list signal, a private event's existence, or the
 * occupancy of a hidden-count event to the entire internet. The pinned contract
 * (SCHEMA "get_event_by_slug 字段边界" + "私密 + 密码闸顺序"; D3/D5/D7②; G1/G4) is
 * hammered from every angle:
 *
 *   1. FIELD TIERS. Un-unlocked callers get the first-tier façade ONLY: title,
 *      cover, description, location_CITY, dates, host name, rsvp_enabled. The full
 *      address (location_text/location_url) and the unlock signal appear ONLY when
 *      the shared gate (guest_unlock_status) says the token/account unlocks. No
 *      token / forged token / cross-event token / not_going token ⇒ no address.
 *   2. PRIVATE GATE (D3). visibility='private' returns NULL to anyone who is not
 *      service_role — anon AND authenticated guests — even WITH a valid unlock
 *      token, and even as an existence oracle. service_role (the trusted SSR path)
 *      may read it. The gate is the FUNCTION's job, not "the SSR layer won't call".
 *   3. COUNT RULE (D7②). going_count / capacity_remaining are OMITTED (keys absent,
 *      省略而非置0) when hide_guest_count, OR private-and-not-unlocked. When shown,
 *      occupancy counts going INCLUDING plus-ones and EXCLUDES maybe/not_going.
 *   4. PASSWORD GATE. A view_password_hash with no/wrong password yields only the
 *      minimal locked response (title/cover, no second tier). service_role does NOT
 *      bypass it. Gate ORDER: private is checked BEFORE password (a private+password
 *      event is NULL to anon, not a locked façade). bcrypt is real, not a stub.
 *   5. THIRD TIER NEVER LEAKS. contact, raw view_password_hash, other guests'
 *      tokens never appear in ANY response shape (façade, unlocked, or locked).
 *
 * Calls go over PostgREST (.rpc) on the real role paths — anon presents a token,
 * an authenticated host session exercises the role gate, service is the trusted
 * SSR path — because auth.role()/auth.uid() only reflect the caller's JWT over that
 * wire. Seeding is done as the postgres superuser (psql): with Supabase auto-expose
 * OFF, anon/service have no API grant on events/guests/rsvps so PostgREST can't
 * INSERT them. Same pattern as the 1.1–1.5.0 suites. Gated on a reachable local
 * stack so the file skips (green) without Docker; where the stack IS up, the gate
 * must really hold.
 */
const LOCAL_UP = localStackRunning();

const FN = "get_event_by_slug";
const FN_PW = "verify_event_password";

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

/** Last non-empty line of psql `-At` output. */
function scalar(out: string): string {
  return out.trim().split("\n").filter(Boolean).pop() ?? "";
}

/** The IN-parameter names of a function, in order (from pg_proc). */
function inArgNames(fn: string): string[] {
  const namesRaw = scalar(
    runSql(
      `select coalesce(array_to_string(proargnames, ','), '') from pg_proc
         where proname='${fn}' and pronamespace='public'::regnamespace limit 1;`,
    ),
  );
  const modesRaw = scalar(
    runSql(
      `select coalesce(array_to_string(proargmodes::text[], ','), '') from pg_proc
         where proname='${fn}' and pronamespace='public'::regnamespace limit 1;`,
    ),
  );
  const names = namesRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const modes = modesRaw ? modesRaw.split(",").map((s) => s.trim()) : [];
  return names.filter((_, idx) => modes.length === 0 || modes[idx] === "i" || modes[idx] === "b");
}

// A PostgREST response, structurally.
type ApiResult = { data: unknown; error: unknown };
type EventObj = Record<string, unknown> | null;

// ── Sentinels — unique enough to prove a specific value never crosses a boundary.
const TITLE_PREFIX = "t15a";
const SLUG_PUB = "t15a-public-open"; // public, count shown, full address present
const SLUG_HIDDEN = "t15a-public-hidden"; // public + hide_guest_count=true
const SLUG_PUB2 = "t15a-public-other"; // a *different* public event (cross-event probe)
const SLUG_PRIV = "t15a-private"; // private, published
const SLUG_PWD = "t15a-password"; // public + password
const SLUG_PRIV_PWD = "t15a-private-password"; // private + password (gate-order probe)

const SENTINEL_ADDR = "t15a-FULL-ADDRESS-42-Secret-Lane-SENTINEL"; // location_text (2nd tier)
const SENTINEL_URL = "https://t15a-venue-secret.invalid/map"; // location_url (2nd tier)
const SENTINEL_CONTACT = "t15a-contact-secret@sentinel.invalid"; // 3rd tier, must NEVER appear
const CITY = "t15a-Brooklyn"; // location_city (1st tier, MAY appear)
const PASSWORD = "t15a-correct-horse-battery-staple";
const WRONG_PASSWORD = "t15a-incorrect-password";

// Fixed guest_token uuids so forged / cross-event probes are deterministic.
const T_GOING = "15a00000-0000-4000-8000-000000000001"; // PUB, going, +2 plus_ones, has contact
const T_MAYBE = "15a00000-0000-4000-8000-000000000002"; // PUB, maybe (unlocks; NOT counted)
const T_NOTGOING = "15a00000-0000-4000-8000-000000000003"; // PUB, not_going (locked; NOT counted)
const T_PRIV = "15a00000-0000-4000-8000-000000000004"; // PRIV, going
const T_PWD = "15a00000-0000-4000-8000-000000000005"; // PWD, going
const T_FORGED = "15a00000-0000-4000-8000-0000000000ff"; // valid uuid, never inserted

/** Own-key check that doesn't trip on inherited props — used for "key OMITTED". */
function hasKey(obj: EventObj, key: string): boolean {
  return obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Third-tier fields must never appear in ANY returned shape (D7② 第三类). */
function assertNoThirdTier(data: EventObj): void {
  const json = JSON.stringify(data ?? {});
  expect(json, "host-only contact must never ride along").not.toContain(SENTINEL_CONTACT);
  expect(hasKey(data, "contact"), "contact must never be a returned key").toBe(false);
  expect(hasKey(data, "view_password_hash"), "raw password hash must never leak").toBe(false);
  expect(hasKey(data, "guest_token"), "no guest_token in the read path").toBe(false);
  expect(hasKey(data, "user_id"), "no guest user_id in the read path").toBe(false);
}

describe("task 1.5a [SECURITY]: get_event_by_slug tiered read path (TEST-SPEC §1.5a)", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

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
  /** Authenticated path — caller's JWT, so auth.role()='authenticated' inside the fn. */
  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  /** Call get_event_by_slug over PostgREST; omit token/password to leave them null. */
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
    expect(hostB?.id, "need >=2 host sessions (host B, for the authenticated-non-host gate)").toBeTruthy();

    // Signature is pinned (SCHEMA RPC table): (slug, guest_token, password).
    expect(inArgNames(FN), "get_event_by_slug signature is pinned").toEqual([
      "slug",
      "guest_token",
      "password",
    ]);
    expect(inArgNames(FN_PW), "verify_event_password signature is pinned").toEqual(["slug", "password"]);

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where title like '${TITLE_PREFIX}%' or slug like '${TITLE_PREFIX}%';`);

    // Host profiles are auto-created by the auth.users trigger; upsert defensively.
    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't15a host A'), ('${hostB.id}', 't15a host B')
         on conflict (id) do nothing;`,
    );

    // Events. All carry the SAME sentinel address/url/city so a leak is unambiguous.
    runSql(
      `insert into public.events
         (host_id, slug, title, description, cover_image_url, visibility, status,
          capacity, location_text, location_url, location_city, hide_guest_count) values
         ('${hostA.id}','${SLUG_PUB}','t15a Public Open','public desc','https://cover/pub.png','public','published',10,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false),
         ('${hostA.id}','${SLUG_HIDDEN}','t15a Public Hidden','hidden desc','https://cover/h.png','public','published',10,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',true),
         ('${hostA.id}','${SLUG_PUB2}','t15a Public Other','other desc','https://cover/o.png','public','published',10,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false),
         ('${hostA.id}','${SLUG_PRIV}','t15a Private','private desc','https://cover/p.png','private','published',5,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false),
         ('${hostA.id}','${SLUG_PWD}','t15a Password','pwd desc','https://cover/pw.png','public','published',8,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false),
         ('${hostA.id}','${SLUG_PRIV_PWD}','t15a Private Password','priv pwd desc','https://cover/ppw.png','private','published',8,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false);`,
    );

    // Real bcrypt hashes (gen_salt('bf',12)) on the two password events — verify_event_password
    // and the password gate must reproduce these, proving they actually hash (not a stub).
    runSql(
      `update public.events
         set view_password_hash = extensions.crypt('${PASSWORD}', extensions.gen_salt('bf', 12))
         where slug in ('${SLUG_PWD}', '${SLUG_PRIV_PWD}');`,
    );

    // Guests: a going (+2 plus_ones, with contact), a maybe, a not_going on PUB;
    // a going on PRIV and on PWD. The maybe/not_going pin the going-only count rule.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact) values
         ((select id from public.events where slug='${SLUG_PUB}'),  '${T_GOING}'::uuid,    't15a going',    '${SENTINEL_CONTACT}'),
         ((select id from public.events where slug='${SLUG_PUB}'),  '${T_MAYBE}'::uuid,    't15a maybe',    null),
         ((select id from public.events where slug='${SLUG_PUB}'),  '${T_NOTGOING}'::uuid, 't15a notgoing', null),
         ((select id from public.events where slug='${SLUG_PRIV}'), '${T_PRIV}'::uuid,     't15a priv go',  null),
         ((select id from public.events where slug='${SLUG_PWD}'),  '${T_PWD}'::uuid,      't15a pwd go',   null);`,
    );

    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_GOING}'::uuid    then 'going'
             when '${T_MAYBE}'::uuid    then 'maybe'
             when '${T_NOTGOING}'::uuid then 'not_going'
             when '${T_PRIV}'::uuid     then 'going'
             when '${T_PWD}'::uuid      then 'going'
           end,
           case g.guest_token when '${T_GOING}'::uuid then 2 else 0 end
         from public.guests g
         where g.guest_token in ('${T_GOING}'::uuid,'${T_MAYBE}'::uuid,'${T_NOTGOING}'::uuid,
               '${T_PRIV}'::uuid,'${T_PWD}'::uuid);`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${TITLE_PREFIX}%' or slug like '${TITLE_PREFIX}%';`);
  });

  // ── §1.5a bullet 1 — no/forged/cross-event/not_going token ⇒ NO address, NO unlock ──
  it.skipIf(!LOCAL_UP)(
    "un-unlocked callers (no token / forged / cross-event / not_going) get the façade but NO location_text and unlocked=false",
    async () => {
      const an = anon();

      // No token at all.
      const none = await callSlug(an, SLUG_PUB);
      expect(none.res.error, JSON.stringify(none.res.error)).toBeNull();
      expect(none.data, "public event must return a façade").not.toBeNull();
      expect(none.data?.unlocked, "no token ⇒ not unlocked").toBe(false);
      expect(hasKey(none.data, "location_text"), "address key OMITTED when locked").toBe(false);
      expect(hasKey(none.data, "location_url"), "venue url OMITTED when locked").toBe(false);
      expect(JSON.stringify(none.data)).not.toContain(SENTINEL_ADDR);
      expect(JSON.stringify(none.data)).not.toContain(SENTINEL_URL);
      // First tier IS present — proves tiering is field-level, not all-or-nothing.
      expect(none.data?.title).toBe("t15a Public Open");
      expect(none.data?.location_city, "city-level is first tier").toBe(CITY);
      assertNoThirdTier(none.data);

      // Forged token (valid uuid, matches no guest) must not unlock.
      const forged = await callSlug(an, SLUG_PUB, { token: T_FORGED });
      expect(forged.res.error, JSON.stringify(forged.res.error)).toBeNull();
      expect(forged.data?.unlocked, "forged token must not unlock").toBe(false);
      expect(hasKey(forged.data, "location_text")).toBe(false);
      expect(JSON.stringify(forged.data)).not.toContain(SENTINEL_ADDR);

      // Cross-event replay: PUB's going token presented to a DIFFERENT public event.
      const cross = await callSlug(an, SLUG_PUB2, { token: T_GOING });
      expect(cross.res.error, JSON.stringify(cross.res.error)).toBeNull();
      expect(cross.data?.unlocked, "event A's token must not unlock event B").toBe(false);
      expect(hasKey(cross.data, "location_text"), "cross-event token must not reveal address").toBe(false);
      expect(JSON.stringify(cross.data)).not.toContain(SENTINEL_ADDR);

      // 更狠: a REAL token whose RSVP is not_going (a decline must not reveal address).
      const decline = await callSlug(an, SLUG_PUB, { token: T_NOTGOING });
      expect(decline.data?.unlocked, "not_going must not unlock").toBe(false);
      expect(hasKey(decline.data, "location_text")).toBe(false);
      expect(JSON.stringify(decline.data)).not.toContain(SENTINEL_ADDR);
    },
  );

  // ── §1.5a bullet 2 — a valid unlocking token reveals the address + unlock signal ──
  it.skipIf(!LOCAL_UP)(
    "valid unlocked token (going AND maybe) ⇒ location_text/location_url present + unlocked=true",
    async () => {
      const going = await callSlug(anon(), SLUG_PUB, { token: T_GOING });
      expect(going.res.error, JSON.stringify(going.res.error)).toBeNull();
      expect(going.data?.unlocked, "going token unlocks").toBe(true);
      expect(going.data?.location_text, "full address returned after unlock").toBe(SENTINEL_ADDR);
      expect(going.data?.location_url).toBe(SENTINEL_URL);
      assertNoThirdTier(going.data); // even unlocked, contact/hash never appear

      // 更狠: maybe is in the unlock set too — it must also reveal the address.
      const maybe = await callSlug(anon(), SLUG_PUB, { token: T_MAYBE });
      expect(maybe.data?.unlocked, "maybe is in the unlock set").toBe(true);
      expect(maybe.data?.location_text).toBe(SENTINEL_ADDR);
    },
  );

  // ── §1.5a bullet 3 — private gate (D3): NULL to anyone not service_role ──────────
  it.skipIf(!LOCAL_UP)(
    "private event ⇒ get_event_by_slug returns NULL to anon (the FUNCTION refuses, not the SSR layer)",
    async () => {
      const an = await callSlug(anon(), SLUG_PRIV);
      expect(an.res.error, JSON.stringify(an.res.error)).toBeNull();
      expect(an.data, "anon must get NULL for a private slug — no façade, no existence oracle").toBeNull();

      // 更狠: even WITH a genuinely-unlocking token, anon still gets null — the role
      // gate is checked before (and independent of) the unlock gate.
      const anTok = await callSlug(anon(), SLUG_PRIV, { token: T_PRIV });
      expect(anTok.data, "a valid token must NOT bypass the private role gate for anon").toBeNull();

      // 更狠: an authenticated NON-host guest (role 'authenticated') is also refused —
      // the gate keys on service_role, not merely "logged in".
      const authed = await callSlug(asHost(hostB.accessToken), SLUG_PRIV);
      expect(authed.res.error, JSON.stringify(authed.res.error)).toBeNull();
      expect(authed.data, "authenticated non-host must also get NULL for a private slug").toBeNull();
    },
  );

  // ── §1.5a bullet 4 — service_role (trusted SSR) may read private; tiering still holds ──
  it.skipIf(!LOCAL_UP)(
    "service_role reads a private event; without a token the address+count are still withheld, with a token they appear",
    async () => {
      // SSR path, no unlock token: façade only. Private+not-unlocked ⇒ count omitted.
      const ssr = await callSlug(service(), SLUG_PRIV);
      expect(ssr.res.error, JSON.stringify(ssr.res.error)).toBeNull();
      expect(ssr.data, "service_role may read a private event").not.toBeNull();
      expect(ssr.data?.title).toBe("t15a Private");
      expect(ssr.data?.unlocked, "service alone does not 'unlock' second tier").toBe(false);
      expect(hasKey(ssr.data, "location_text"), "no address without an unlock token").toBe(false);
      expect(hasKey(ssr.data, "going_count"), "private+not-unlocked ⇒ count key OMITTED (D7②)").toBe(false);
      expect(hasKey(ssr.data, "capacity_remaining")).toBe(false);
      assertNoThirdTier(ssr.data);

      // SSR path WITH a valid unlock token (the way the SSR layer relays the guest's
      // token): now the second tier and the count appear.
      const ssrTok = await callSlug(service(), SLUG_PRIV, { token: T_PRIV });
      expect(ssrTok.data?.unlocked, "service + valid token unlocks").toBe(true);
      expect(ssrTok.data?.location_text, "address revealed on the unlocked SSR path").toBe(SENTINEL_ADDR);
      expect(hasKey(ssrTok.data, "going_count"), "private+unlocked ⇒ count shown").toBe(true);
      expect(ssrTok.data?.going_count, "1 going +0 plus-ones on PRIV").toBe(1);
    },
  );

  // ── §1.5a bullet 5 — count rule (D7②): omitted keys, never zeroed; occupancy math ──
  it.skipIf(!LOCAL_UP)(
    "going_count/capacity_remaining: present & correct on a public event, OMITTED (not zeroed) when hide_guest_count",
    async () => {
      // Public, count not hidden: keys present. Occupancy counts going INCLUDING
      // plus-ones (1+2=3) and EXCLUDES the maybe and not_going guests.
      const pub = await callSlug(anon(), SLUG_PUB);
      expect(hasKey(pub.data, "going_count"), "public non-hidden ⇒ count key present").toBe(true);
      expect(pub.data?.going_count, "going(1) + plus_ones(2); maybe/not_going excluded").toBe(3);
      expect(pub.data?.capacity_remaining, "capacity 10 − occupancy 3").toBe(7);

      // hide_guest_count=true ⇒ BOTH keys absent (省略而非置0 — not present-as-0).
      const hidden = await callSlug(anon(), SLUG_HIDDEN);
      expect(hidden.res.error, JSON.stringify(hidden.res.error)).toBeNull();
      expect(hidden.data, "hidden-count event still returns a façade").not.toBeNull();
      expect(hasKey(hidden.data, "going_count"), "hide_guest_count ⇒ going_count key OMITTED").toBe(false);
      expect(hasKey(hidden.data, "capacity_remaining"), "hide_guest_count ⇒ remaining key OMITTED").toBe(false);
      // Pin "omitted, NOT zeroed": the value must not be present as 0/null either.
      expect(hidden.data?.going_count, "must be undefined (key gone), never 0").toBeUndefined();
    },
  );

  // ── §1.5a bullet 6 — password gate: minimal locked response vs normal tiering ────
  it.skipIf(!LOCAL_UP)(
    "password event with no/wrong password ⇒ minimal locked response (title/cover, no 2nd tier, no count)",
    async () => {
      const expectLocked = (data: EventObj, label: string) => {
        expect(data, `${label}: still returns a locked façade`).not.toBeNull();
        expect(data?.locked, `${label}: locked=true`).toBe(true);
        expect(data?.requires_password, `${label}: requires_password=true`).toBe(true);
        expect(data?.unlocked, `${label}: unlocked=false while locked`).toBe(false);
        expect(data?.title, `${label}: title present for the box/preview`).toBe("t15a Password");
        expect(data?.cover_image_url, `${label}: cover present for share preview`).toBe("https://cover/pw.png");
        // Nothing second-tier, no occupancy oracle behind the password.
        expect(hasKey(data, "location_text"), `${label}: NO address behind the lock`).toBe(false);
        expect(hasKey(data, "location_url"), `${label}: NO venue url behind the lock`).toBe(false);
        expect(hasKey(data, "going_count"), `${label}: NO count behind the lock`).toBe(false);
        expect(JSON.stringify(data)).not.toContain(SENTINEL_ADDR);
        assertNoThirdTier(data);
      };

      // No password supplied.
      const noPw = await callSlug(anon(), SLUG_PWD);
      expect(noPw.res.error, JSON.stringify(noPw.res.error)).toBeNull();
      expectLocked(noPw.data, "no-password");

      // Wrong password.
      const wrongPw = await callSlug(anon(), SLUG_PWD, { password: WRONG_PASSWORD });
      expectLocked(wrongPw.data, "wrong-password");

      // 更狠: presenting a VALID unlock token but the WRONG password still stays
      // locked — the password gate fires before the unlock branch.
      const tokWrongPw = await callSlug(anon(), SLUG_PWD, { token: T_PWD, password: WRONG_PASSWORD });
      expectLocked(tokWrongPw.data, "token+wrong-password");
    },
  );

  it.skipIf(!LOCAL_UP)(
    "correct password ⇒ normal tiering resumes (façade+count), and with an unlock token the address appears",
    async () => {
      // Correct password, no unlock token: past the lock, normal façade + count
      // (public). Still no address — that needs an actual RSVP unlock.
      const pw = await callSlug(anon(), SLUG_PWD, { password: PASSWORD });
      expect(pw.res.error, JSON.stringify(pw.res.error)).toBeNull();
      expect(pw.data?.locked, "correct password ⇒ not locked").toBe(false);
      expect(pw.data?.requires_password, "still flagged as a password event").toBe(true);
      expect(pw.data?.unlocked, "password alone is not an RSVP unlock").toBe(false);
      expect(hasKey(pw.data, "going_count"), "public ⇒ count shown once past the lock").toBe(true);
      expect(hasKey(pw.data, "location_text"), "no address without an RSVP unlock").toBe(false);
      assertNoThirdTier(pw.data);

      // Correct password AND a valid unlock token: full second tier.
      const pwTok = await callSlug(anon(), SLUG_PWD, { token: T_PWD, password: PASSWORD });
      expect(pwTok.data?.locked).toBe(false);
      expect(pwTok.data?.unlocked, "correct password + going token ⇒ unlocked").toBe(true);
      expect(pwTok.data?.location_text, "address revealed with password+token").toBe(SENTINEL_ADDR);
    },
  );

  // ── §1.5a 更狠 — gate ORDER: private is checked BEFORE password ───────────────────
  it.skipIf(!LOCAL_UP)(
    "private+password event: anon gets NULL (private gate first), service gets the locked façade (password not bypassed)",
    async () => {
      // Private gate runs first, so anon gets a flat NULL — NOT the password-locked
      // façade. A private event must not even reveal that it is password-protected.
      const an = await callSlug(anon(), SLUG_PRIV_PWD);
      expect(an.res.error, JSON.stringify(an.res.error)).toBeNull();
      expect(an.data, "private+password ⇒ NULL to anon (private gate precedes password)").toBeNull();

      // service_role passes the private gate but NOT the password gate: it gets the
      // minimal locked response, proving service_role does not bypass the password.
      const ssr = await callSlug(service(), SLUG_PRIV_PWD);
      expect(ssr.res.error, JSON.stringify(ssr.res.error)).toBeNull();
      expect(ssr.data, "service_role reaches the private+password event").not.toBeNull();
      expect(ssr.data?.locked, "service_role does NOT bypass the password gate").toBe(true);
      expect(hasKey(ssr.data, "location_text"), "no address behind the password even for SSR").toBe(false);
      expect(JSON.stringify(ssr.data)).not.toContain(SENTINEL_ADDR);
      assertNoThirdTier(ssr.data);

      // service_role WITH the correct password is past both gates.
      const ssrPw = await callSlug(service(), SLUG_PRIV_PWD, { password: PASSWORD });
      expect(ssrPw.data?.locked, "service + correct password ⇒ unlocked façade").toBe(false);
    },
  );

  // ── §1.5a — unknown slug is not an existence oracle ──────────────────────────────
  it.skipIf(!LOCAL_UP)("unknown slug ⇒ NULL (no existence oracle)", async () => {
    const miss = await callSlug(anon(), "t15a-does-not-exist-xyz");
    expect(miss.res.error, JSON.stringify(miss.res.error)).toBeNull();
    expect(miss.data, "unknown slug returns null, same as private — no oracle").toBeNull();
  });

  // ── §1.5a (password verifier) — verify_event_password is a REAL bcrypt check ─────
  it.skipIf(!LOCAL_UP)(
    "verify_event_password: correct⇒true, wrong⇒false, null⇒false, unknown slug⇒false, no-password event⇒true",
    async () => {
      const an = anon();
      // verify_event_password(slug, password) has NO default arg, so the candidate
      // is ALWAYS sent — passing an explicit JSON null exercises the `password is
      // null → false` branch (omitting the key would leave PostgREST unable to
      // resolve the 2-arg function, which would not test the implementation).
      const verify = async (slug: string, password: string | null) => {
        const res = (await an.rpc(FN_PW, { slug, password })) as ApiResult;
        return res;
      };

      const ok = await verify(SLUG_PWD, PASSWORD);
      expect(ok.error, JSON.stringify(ok.error)).toBeNull();
      expect(ok.data, "correct password ⇒ true").toBe(true);

      const bad = await verify(SLUG_PWD, WRONG_PASSWORD);
      expect(bad.data, "wrong password ⇒ false").toBe(false);

      const nullPw = await verify(SLUG_PWD, null);
      expect(nullPw.data, "hash set but no candidate ⇒ false").toBe(false);

      const unknown = await verify("t15a-does-not-exist-xyz", PASSWORD);
      expect(unknown.data, "unknown slug ⇒ false (nothing to grant)").toBe(false);

      // An event with no password is an open gate — verifier returns true.
      const open = await verify(SLUG_PUB, "anything-at-all");
      expect(open.data, "event without a password hash ⇒ gate open ⇒ true").toBe(true);

      // 更狠: a near-miss (correct password + trailing space) must NOT verify — proves
      // it's a real constant-input bcrypt compare, not a loose/substring match.
      const nearMiss = await verify(SLUG_PWD, `${PASSWORD} `);
      expect(nearMiss.data, "near-miss password must not verify").toBe(false);
    },
  );
});
