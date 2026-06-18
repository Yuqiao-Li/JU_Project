import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Batch 6 — three changes, all hammered adversarially by the INDEPENDENT test agent
 * (never wrote the implementation; assume it over-shares / freezes / lies).
 *
 *  H16 [SECURITY] — migration 0018: `get_event_by_slug` + `guest_unlock_status` gain a
 *      TRUSTED `viewer_id uuid` so a logged-in user unlocks via their account
 *      (guests.user_id) WITHOUT a localStorage token. The crux: viewer_id must be
 *      HONOURED ONLY for service_role (the trusted SSR path), mirroring 0015's
 *      password_verified. A non-service-role caller passing viewer_id must NOT be able to
 *      impersonate a user and reveal the address / guest-list. This is the key anti-abuse
 *      assertion. Exercised at the RPC boundary on the real role paths (anon key / host
 *      session / service role), seeded as the postgres superuser via psql — same posture
 *      as migration-0006 / migration-0007 / task-2.5.
 *
 *  H14 — event-client.tsx: the post-RSVP unlock re-read is a DISCRIMINATED result
 *      (ok/locked/failed); a genuine `failed` re-read surfaces a RETRY affordance
 *      (role="alert" + a retry handler) instead of silently freezing; a `locked`
 *      (re-locked password) result is still IGNORED (no clobber); background polling never
 *      shows the loading/retry UI. Static source guard (the React client can't be rendered
 *      under vitest), same posture as task-4-lifecycle.
 *
 *  M26 — rsvp-form.tsx: the "Join waitlist" framing is derived from `isFull && !viewerIsGoing`
 *      — a viewer who already holds a going seat is NOT relabelled to "Join waitlist", while
 *      a not-going viewer on a full event still is. Static source guard.
 */

const LOCAL_UP = localStackRunning();

// ─────────────────────────────────────────────────────────────────────────────
// H16 — DB / RPC: the trusted viewer_id account-unlock boundary.
// ─────────────────────────────────────────────────────────────────────────────

const FN = "get_event_by_slug";
const FN_GATE = "guest_unlock_status";

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

/** The IN/INOUT-parameter names of a function, in order (OUT params excluded). */
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

type ApiResult = { data: unknown; error: unknown };
type EventObj = Record<string, unknown> | null;

interface Gate {
  guest_id: string | null;
  unlocked: boolean | null;
  status: string | null;
}

// ── Sentinels — unique enough to prove a value never crosses a boundary. ─────────
const PREFIX = "t6au";
const SLUG_PUB = "t6au-public-open"; // public, count shown, full address present
const SLUG_PUB2 = "t6au-public-other"; // a DIFFERENT public event (cross-event probe)
const SLUG_PRIV = "t6au-private"; // private, published

const SENTINEL_ADDR = "t6au-FULL-ADDRESS-99-Account-Lane-SENTINEL"; // location_text (2nd tier)
const SENTINEL_URL = "https://t6au-venue-secret.invalid/map"; // location_url (2nd tier)
const SENTINEL_CONTACT = "t6au-contact-secret@sentinel.invalid"; // 3rd tier; never appears
const CITY = "t6au-Brooklyn"; // location_city (1st tier, MAY appear)

// Fixed guest_token uuids so token / forged probes are deterministic.
const T_TOKEN_GOING = "6a000000-0000-4000-8000-000000000001"; // PUB, going, token-only (no user_id)
const T_FORGED = "6a000000-0000-4000-8000-0000000000ff"; // valid uuid, never inserted

// guest_token uuids for the ACCOUNT-linked guests (these guests carry user_id, not used as
// the unlock credential — the account branch is what we test).
const T_ACCT_A_PUB = "6a000000-0000-4000-8000-000000000010"; // PUB guest linked to host A, going
const T_ACCT_A_PRIV = "6a000000-0000-4000-8000-000000000011"; // PRIV guest linked to host A, going
const T_ACCT_B_PUB = "6a000000-0000-4000-8000-000000000012"; // PUB guest linked to host B, NOT_GOING

function hasKey(obj: EventObj, key: string): boolean {
  return obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

function assertNoThirdTier(data: EventObj): void {
  const json = JSON.stringify(data ?? {});
  expect(json, "host-only contact must never ride along").not.toContain(SENTINEL_CONTACT);
  expect(hasKey(data, "contact"), "contact must never be a returned key").toBe(false);
  expect(hasKey(data, "view_password_hash"), "raw password hash must never leak").toBe(false);
  expect(hasKey(data, "user_id"), "no guest user_id in the read path").toBe(false);
}

describe("Batch 6 [SECURITY] H16: get_event_by_slug + guest_unlock_status trusted viewer_id", () => {
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
  /** Authenticated path — caller's JWT, so auth.role()='authenticated', auth.uid()=host.id. */
  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  /** Call get_event_by_slug over PostgREST; only set provided args (rest default null). */
  async function callSlug(
    client: SupabaseClient,
    slug: string,
    opts: { token?: string; viewerId?: string } = {},
  ): Promise<{ res: ApiResult; data: EventObj }> {
    const body: Record<string, unknown> = { slug };
    if (opts.token !== undefined) body.guest_token = opts.token;
    if (opts.viewerId !== undefined) body.viewer_id = opts.viewerId;
    const res = (await client.rpc(FN, body)) as ApiResult;
    return { res, data: (res.data as EventObj) ?? null };
  }

  /** Call guest_unlock_status over PostgREST; only set provided args. */
  async function callGate(
    client: SupabaseClient,
    eventId: string,
    opts: { token?: string; viewerId?: string } = {},
  ): Promise<{ res: ApiResult; obj: Gate | null }> {
    const body: Record<string, unknown> = { event_id: eventId };
    if (opts.token !== undefined) body.token = opts.token;
    if (opts.viewerId !== undefined) body.viewer_id = opts.viewerId;
    const res = (await client.rpc(FN_GATE, body)) as ApiResult;
    const obj = (Array.isArray(res.data) ? res.data[0] : res.data) as Gate | null;
    return { res, obj };
  }

  let pubId = "";
  let privId = "";

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();
    expect(hostB?.id, "need >=2 host sessions (host B, for the foreign-viewer gate)").toBeTruthy();

    // Signature is pinned: the trusted viewer_id is APPENDED LAST after 0015's
    // password_verified, exactly mirroring how the trusted bypass arg was added.
    expect(inArgNames(FN), "get_event_by_slug signature is pinned (viewer_id appended last)").toEqual([
      "slug",
      "guest_token",
      "password",
      "password_verified",
      "viewer_id",
    ]);
    // guest_unlock_status gains viewer_id as its 4th input (after event_id, token).
    expect(inArgNames(FN_GATE), "guest_unlock_status gains viewer_id as 4th input").toEqual([
      "event_id",
      "token",
      "viewer_id",
    ]);
    expect(
      inArgNames(FN_GATE),
      "contact must never be an input to the gate (D1)",
    ).not.toContain("contact");

    // Idempotent reset (slug is UNIQUE).
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);

    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't6au host A'), ('${hostB.id}', 't6au host B')
         on conflict (id) do nothing;`,
    );

    pubId = scalar(
      runSql(
        `with ins as (insert into public.events
           (host_id, slug, title, description, cover_image_url, visibility, status,
            capacity, location_text, location_url, location_city, hide_guest_count)
           values ('${hostA.id}','${SLUG_PUB}','t6au Public Open','public desc','https://cover/pub.png','public','published',10,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',false)
           returning id) select id from ins;`,
      ),
    );
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, capacity, location_text, location_url, location_city)
         values ('${hostA.id}','${SLUG_PUB2}','t6au Public Other','public','published',10,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}');`,
    );
    privId = scalar(
      runSql(
        `with ins as (insert into public.events
           (host_id, slug, title, visibility, status, capacity, location_text, location_url, location_city)
           values ('${hostA.id}','${SLUG_PRIV}','t6au Private','private','published',5,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}')
           returning id) select id from ins;`,
      ),
    );

    // Guests.
    //   - T_TOKEN_GOING: token-only going guest on PUB (no user_id) — token path control.
    //   - T_ACCT_A_PUB: PUB guest linked to host A's account (user_id), going — the account
    //     branch should unlock THIS via viewer_id=hostA without a token.
    //   - T_ACCT_A_PRIV: PRIV guest linked to host A, going.
    //   - T_ACCT_B_PUB: PUB guest linked to host B, not_going — account branch must respect it.
    // host A is deliberately NOT given an account row on SLUG_PUB2, so an A-viewer there
    // resolves to NO account (the "no linked guest" case).
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact, user_id) values
         ('${pubId}',  '${T_TOKEN_GOING}'::uuid, 't6au tok going', '${SENTINEL_CONTACT}', null),
         ('${pubId}',  '${T_ACCT_A_PUB}'::uuid,  't6au acctA pub', null, '${hostA.id}'),
         ('${privId}', '${T_ACCT_A_PRIV}'::uuid, 't6au acctA priv', null, '${hostA.id}'),
         ('${pubId}',  '${T_ACCT_B_PUB}'::uuid,  't6au acctB pub', null, '${hostB.id}');`,
    );

    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_TOKEN_GOING}'::uuid then 'going'
             when '${T_ACCT_A_PUB}'::uuid  then 'going'
             when '${T_ACCT_A_PRIV}'::uuid then 'going'
             when '${T_ACCT_B_PUB}'::uuid  then 'not_going'
           end, 0
         from public.guests g
         where g.guest_token in ('${T_TOKEN_GOING}'::uuid,'${T_ACCT_A_PUB}'::uuid,
               '${T_ACCT_A_PRIV}'::uuid,'${T_ACCT_B_PUB}'::uuid);`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  // ── The headline H16 capability: service_role + viewer_id unlocks WITHOUT a token ──
  it.skipIf(!LOCAL_UP)(
    "service_role + viewer_id (a user with a going account row) ⇒ unlocks (address present) WITH NO guest_token",
    async () => {
      const ssr = await callSlug(service(), SLUG_PUB, { viewerId: hostA.id });
      expect(ssr.res.error, JSON.stringify(ssr.res.error)).toBeNull();
      expect(ssr.data, "public event resolves").not.toBeNull();
      expect(ssr.data?.unlocked, "account branch unlocks via viewer_id on the trusted path").toBe(true);
      expect(ssr.data?.location_text, "full address revealed by the account unlock").toBe(SENTINEL_ADDR);
      expect(ssr.data?.location_url).toBe(SENTINEL_URL);
      assertNoThirdTier(ssr.data);

      // 更狠: the SAME works for a PRIVATE event (the whole reason the arg exists — the SSR
      // path resolves a private event AND the logged-in user re-sees their unlocked tier).
      const priv = await callSlug(service(), SLUG_PRIV, { viewerId: hostA.id });
      expect(priv.data, "service_role reads the private event").not.toBeNull();
      expect(priv.data?.unlocked, "account branch unlocks the private event too").toBe(true);
      expect(priv.data?.location_text).toBe(SENTINEL_ADDR);
      expect(hasKey(priv.data, "going_count"), "private+unlocked ⇒ count shown (D7②)").toBe(true);
    },
  );

  // ── THE KEY ANTI-ABUSE ASSERTION: anon passing viewer_id must NOT unlock. ─────────
  it.skipIf(!LOCAL_UP)(
    "anon passing viewer_id is IGNORED ⇒ NO unlock (cannot impersonate a user to reveal address/list)",
    async () => {
      // An attacker on the public anon key tries to pass a victim's uid as viewer_id to
      // self-grant the account unlock. viewer_id is honoured ONLY for service_role, so this
      // must collapse to "no token, no account" ⇒ locked.
      const an = await callSlug(anon(), SLUG_PUB, { viewerId: hostA.id });
      expect(an.res.error, JSON.stringify(an.res.error)).toBeNull();
      expect(an.data, "public event still returns a façade").not.toBeNull();
      expect(an.data?.unlocked, "anon viewer_id MUST be ignored — no self-granted unlock").toBe(false);
      expect(hasKey(an.data, "location_text"), "address key OMITTED for an anon viewer_id").toBe(false);
      expect(hasKey(an.data, "location_url")).toBe(false);
      expect(JSON.stringify(an.data), "address sentinel must not leak to anon").not.toContain(SENTINEL_ADDR);
      expect(JSON.stringify(an.data)).not.toContain(SENTINEL_URL);
      assertNoThirdTier(an.data);
    },
  );

  // ── An authenticated (non-service) caller passing ANOTHER user's viewer_id: no unlock ──
  it.skipIf(!LOCAL_UP)(
    "authenticated non-service host passing ANOTHER user's viewer_id ⇒ NOT unlocked via that viewer_id",
    async () => {
      // Host B is logged in (role 'authenticated'). They pass host A's uid as viewer_id to
      // try to unlock via A's going account row. Inside the RPC, v_viewer_id is forced to
      // null for non-service_role, and auth.uid() is B's own id — and B has only a
      // not_going row on PUB — so the account branch does NOT unlock with A's identity.
      const b = await callSlug(asHost(hostB.accessToken), SLUG_PUB, { viewerId: hostA.id });
      expect(b.res.error, JSON.stringify(b.res.error)).toBeNull();
      expect(b.data?.unlocked, "an authenticated caller cannot borrow A's identity via viewer_id").toBe(false);
      expect(hasKey(b.data, "location_text"), "no address from a foreign viewer_id").toBe(false);
      expect(JSON.stringify(b.data)).not.toContain(SENTINEL_ADDR);

      // 更狠: even host A — who DOES own the going account row — does not get a second tier
      // by passing their OWN uid as viewer_id on a non-service call (the auth.uid() account
      // branch is what counts there, but viewer_id itself is forced to null; this proves the
      // forcing is unconditional for non-service_role, not selectively bypassed). Host A's
      // own auth.uid() WILL unlock (the legitimate D1 account fallback), so we assert the
      // unlock is driven by auth.uid() and NOT widened/changed by the passed viewer_id:
      // passing a FORGED uid must give the same answer as passing none.
      const aOwn = await callSlug(asHost(hostA.accessToken), SLUG_PUB);
      const aForged = await callSlug(asHost(hostA.accessToken), SLUG_PUB, { viewerId: T_FORGED });
      expect(
        aForged.data?.unlocked,
        "a non-service caller's viewer_id (even a junk one) cannot change the unlock outcome",
      ).toBe(aOwn.data?.unlocked);
    },
  );

  // ── viewer_id of a user with NO linked guests row (or not_going) ⇒ no unlock. ──────
  it.skipIf(!LOCAL_UP)(
    "service_role + viewer_id with NO linked guest (or a not_going account row) ⇒ does NOT unlock",
    async () => {
      // host A has NO account row on SLUG_PUB2 → the account branch finds nothing → locked.
      const noRow = await callSlug(service(), SLUG_PUB2, { viewerId: hostA.id });
      expect(noRow.res.error, JSON.stringify(noRow.res.error)).toBeNull();
      expect(noRow.data?.unlocked, "a viewer with no linked guest on this event does not unlock").toBe(false);
      expect(hasKey(noRow.data, "location_text")).toBe(false);
      expect(JSON.stringify(noRow.data)).not.toContain(SENTINEL_ADDR);

      // host B's only PUB account row is not_going → unlock set is going/maybe/waitlisted only.
      const decline = await callSlug(service(), SLUG_PUB, { viewerId: hostB.id });
      expect(decline.data?.unlocked, "a not_going account row must NOT unlock").toBe(false);
      expect(hasKey(decline.data, "location_text")).toBe(false);
      expect(JSON.stringify(decline.data)).not.toContain(SENTINEL_ADDR);

      // A viewer_id matching no profile at all (forged uid) ⇒ no account row ⇒ locked, even
      // on the trusted path.
      const forged = await callSlug(service(), SLUG_PUB, { viewerId: T_FORGED });
      expect(forged.data?.unlocked, "a viewer_id matching no guest must not unlock").toBe(false);
      expect(hasKey(forged.data, "location_text")).toBe(false);
    },
  );

  // ── Pre-existing rules still hold: private gate, count omission, no inlining. ──────
  it.skipIf(!LOCAL_UP)(
    "private event still returns NULL to non-service_role even WITH a viewer_id (private gate precedes unlock)",
    async () => {
      const an = await callSlug(anon(), SLUG_PRIV, { viewerId: hostA.id });
      expect(an.res.error, JSON.stringify(an.res.error)).toBeNull();
      expect(an.data, "anon must get NULL for a private slug — viewer_id cannot bypass the role gate").toBeNull();

      const authed = await callSlug(asHost(hostB.accessToken), SLUG_PRIV, { viewerId: hostA.id });
      expect(authed.data, "authenticated non-service must also get NULL for a private slug").toBeNull();

      // And the legitimate owner (host A) authenticated, viewing their own private event,
      // still gets NULL — the private gate keys on service_role, not "logged in / owner".
      const owner = await callSlug(asHost(hostA.accessToken), SLUG_PRIV, { viewerId: hostA.id });
      expect(owner.data, "even the owner over the authenticated path gets NULL for a private slug").toBeNull();
    },
  );

  it.skipIf(!LOCAL_UP)(
    "the token path is unchanged: a going token still unlocks; a forged token + no viewer still locks",
    async () => {
      // Token path (no viewer_id) must behave exactly as before — viewer_id adds a branch,
      // it does not regress the token branch.
      const tok = await callSlug(anon(), SLUG_PUB, { token: T_TOKEN_GOING });
      expect(tok.data?.unlocked, "a going token still unlocks (anon, no viewer_id)").toBe(true);
      expect(tok.data?.location_text).toBe(SENTINEL_ADDR);

      const forged = await callSlug(anon(), SLUG_PUB, { token: T_FORGED });
      expect(forged.data?.unlocked, "a forged token still locks").toBe(false);
      expect(hasKey(forged.data, "location_text")).toBe(false);

      // Count omission (D7②) unchanged: public non-hidden ⇒ count keys present.
      const facade = await callSlug(anon(), SLUG_PUB);
      expect(hasKey(facade.data, "going_count"), "public non-hidden ⇒ count present").toBe(true);
      // PUB has 2 going (token guest + acctA) + 0 going from the not_going/none ⇒ occupancy 2.
      expect(facade.data?.going_count, "going headcount counts only going rows").toBe(2);
    },
  );

  // ── get_event_by_slug routes unlock through guest_unlock_status (not inlined). ─────
  it.skipIf(!LOCAL_UP)(
    "get_event_by_slug still routes the unlock decision through guest_unlock_status (G4 / 护栏6 — not inlined)",
    () => {
      // The full multi-line function definition (NOT scalar() — that would keep only the
      // closing line and drop the body we need to grep).
      const body = runSql(
        `select pg_get_functiondef(p.oid) from pg_proc p
           where p.proname='${FN}' and p.pronamespace='public'::regnamespace limit 1;`,
      );
      // The body must still CALL the shared gate (the single unlock predicate) and pass the
      // threaded viewer_id into it — not reimplement the going/maybe/waitlisted check inline.
      expect(
        /guest_unlock_status\s*\(/.test(body),
        "get_event_by_slug body must call guest_unlock_status (single unlock predicate)",
      ).toBe(true);
      // It must NOT inline the unlock-set membership test (that would be a duplicate gate).
      expect(
        /status\s+in\s*\(\s*'going'\s*,\s*'maybe'\s*,\s*'waitlisted'\s*\)/i.test(body),
        "get_event_by_slug must not inline the unlock-set check — it belongs to the gate",
      ).toBe(false);
    },
  );

  // ── guest_unlock_status directly with the new 4th viewer_id arg. ──────────────────
  it.skipIf(!LOCAL_UP)(
    "guest_unlock_status: account branch matches g.user_id = coalesce(auth.uid(), viewer_id); null/foreign viewer_id does not unlock",
    async () => {
      // service_role (auth.uid() NULL) + viewer_id of a going account row ⇒ unlock.
      const ssrA = await callGate(service(), pubId, { viewerId: hostA.id });
      expect(ssrA.res.error, JSON.stringify(ssrA.res.error)).toBeNull();
      expect(ssrA.obj?.unlocked, "service + viewer_id (going account) unlocks the gate directly").toBe(true);
      expect(ssrA.obj?.status).toBe("going");

      // A not_going account viewer_id ⇒ matched the row but the set excludes it ⇒ locked.
      const ssrB = await callGate(service(), pubId, { viewerId: hostB.id });
      expect(ssrB.obj?.unlocked, "service + viewer_id (not_going account) must NOT unlock").toBe(false);
      expect(ssrB.obj?.status).toBe("not_going");

      // A foreign/forged viewer_id (no account row) ⇒ miss ⇒ locked, no leak.
      const ssrForged = await callGate(service(), pubId, { viewerId: T_FORGED });
      expect(ssrForged.obj?.unlocked, "service + viewer_id with no account row ⇒ locked").toBe(false);
      expect(ssrForged.obj?.guest_id, "a forged viewer_id leaks no guest_id").toBeNull();

      // null viewer_id + anon (no auth.uid()) ⇒ account branch can't match anything ⇒ locked.
      const anNone = await callGate(anon(), pubId, {});
      expect(anNone.obj?.unlocked, "no token + null viewer_id + anon ⇒ locked").toBe(false);
      expect(anNone.obj?.guest_id).toBeNull();

      // 更狠 — the gate's viewer_id is NOT itself trusted-gated (the TRUST gating lives in
      // get_event_by_slug); the helper honours coalesce(auth.uid(), viewer_id) for ANY caller.
      // So an ANON passing a viewer_id DOES unlock the GATE directly. This is fine because
      // anon has no direct table access and the public read path NEVER forwards a viewer_id
      // unless service_role — but we pin the behaviour so a regression in get_event_by_slug's
      // forcing-to-null can't hide behind the gate. (auth.uid() is null for anon ⇒ the
      // coalesce reduces to viewer_id.)
      const anViewer = await callGate(anon(), pubId, { viewerId: hostA.id });
      expect(
        anViewer.obj?.unlocked,
        "gate itself applies coalesce(auth.uid(), viewer_id) for any caller (trust gating is the slug-fn's job)",
      ).toBe(true);

      // The TOKEN path is unchanged by the new arg — token still wins / scopes per event.
      const tok = await callGate(anon(), pubId, { token: T_TOKEN_GOING });
      expect(tok.obj?.unlocked, "token path unchanged: going token unlocks the gate").toBe(true);
      expect(tok.obj?.status).toBe("going");
    },
  );

  // ── auth.uid() takes precedence; viewer_id is the SSR-only fallback (coalesce order). ──
  it.skipIf(!LOCAL_UP)(
    "guest_unlock_status: auth.uid() is preferred over viewer_id (an authenticated caller's foreign viewer_id can't override their own identity)",
    async () => {
      // Host B authenticated, passing host A's uid as viewer_id. coalesce(auth.uid(),
      // viewer_id) = auth.uid() = B (non-null), so the viewer_id is NEVER consulted — B's
      // own not_going row governs ⇒ locked. This proves viewer_id can't override a present
      // auth.uid() to borrow another account even at the helper level.
      const b = await callGate(asHost(hostB.accessToken), pubId, { viewerId: hostA.id });
      expect(b.res.error, JSON.stringify(b.res.error)).toBeNull();
      expect(b.obj?.unlocked, "auth.uid() wins over viewer_id ⇒ B's own not_going row governs").toBe(false);
      expect(b.obj?.status, "resolves to B's own account row, not A's going row").toBe("not_going");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// H14 + M26 — static source guards (the React clients can't be rendered under vitest).
// Same posture as task-4-lifecycle.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Read an implementation source file by repo-relative path (relative to this test). */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

describe("Batch 6 H14: post-RSVP unlock is a discriminated result with a retry affordance", () => {
  const CLIENT = src("app/[slug]/event-client.tsx");

  it("the re-read returns a DISCRIMINATED result (ok | locked | failed), not a bare null", () => {
    // The three outcomes must be modelled as a tagged union so callers can tell
    // "unlock failed" from "re-locked" — the core of H14.
    expect(
      /kind:\s*"ok"/.test(CLIENT) && /kind:\s*"locked"/.test(CLIENT) && /kind:\s*"failed"/.test(CLIENT),
      "event-client: SnapshotResult models ok/locked/failed",
    ).toBe(true);
    // fetchSnapshot must return the union, not Promise<… | null>.
    expect(
      /fetchSnapshot[\s\S]{0,120}Promise<\s*SnapshotResult\s*>/.test(CLIENT),
      "event-client: fetchSnapshot returns Promise<SnapshotResult>",
    ).toBe(true);
  });

  it("a genuine `failed` post-submit re-read surfaces a RETRY affordance (role=alert + a retry handler)", () => {
    // After submit, the failed branch must set a 'failed' state and render an alert with a
    // retry control — NOT silently freeze on the first-tier page.
    expect(
      /setUnlockState\(\s*result2\.kind === "failed"\s*\?\s*"failed"\s*:\s*"idle"\s*\)/.test(CLIENT),
      "event-client: post-submit re-read maps a failed result to the 'failed' state",
    ).toBe(true);
    expect(
      /unlockState === "failed"[\s\S]*role="alert"/.test(CLIENT),
      "event-client: the failed state renders a role=alert affordance",
    ).toBe(true);
    // A retry handler exists and is wired to a control inside the failed UI.
    expect(
      /retryUnlock\b/.test(CLIENT) && /onClick=\{\s*\(\)\s*=>\s*void retryUnlock\(\)\s*\}/.test(CLIENT),
      "event-client: a retryUnlock handler is bound to the retry control",
    ).toBe(true);
    // The retry actually re-reads and re-evaluates the failed state (not a no-op).
    expect(
      /const retryUnlock[\s\S]{0,400}fetchSnapshot\(slug, token\)[\s\S]{0,200}setUnlockState\(\s*result\.kind === "failed"/.test(
        CLIENT,
      ),
      "event-client: retryUnlock re-reads and re-derives the failed state",
    ).toBe(true);
  });

  it("a `locked` (re-locked password) re-read is IGNORED — no clobber of a good view", () => {
    // applySnapshot only applies an `ok` result; locked & failed are dropped so a transient
    // error or a re-lock never overwrites an already-unlocked view.
    expect(
      /applySnapshot\s*=\s*useCallback\(\s*\(result:\s*SnapshotResult\)\s*=>\s*\{\s*if\s*\(result\.kind !== "ok"\)\s*return;/.test(
        CLIENT,
      ),
      "event-client: applySnapshot short-circuits unless kind === 'ok' (locked/failed ignored)",
    ).toBe(true);
    // fetchSnapshot tags a re-locked password read as `locked`, distinct from `failed`.
    expect(
      /parsed\.data\.locked\)\s*return\s*\{\s*kind:\s*"locked"\s*\}/.test(CLIENT),
      "event-client: a locked payload becomes { kind: 'locked' }, not 'failed'",
    ).toBe(true);
  });

  it("background polling NEVER shows the loading/retry UI (only the post-submit + retry paths set unlockState)", () => {
    // The polling effect calls applySnapshot but must NOT touch unlockState — otherwise a
    // routine background re-read flicker would pop the loading/retry chrome. Only
    // handleSubmitted and retryUnlock may set unlockState.
    const setCalls = CLIENT.match(/setUnlockState\(/g) ?? [];
    // Expect exactly the post-submit (loading + result), the retry (idle-guard + loading + result):
    // 5 occurrences — none inside the poll() body.
    expect(setCalls.length, "setUnlockState is confined to submit/retry paths (not polling)").toBeLessThanOrEqual(6);

    // The poll() function body must not contain setUnlockState — extract it and check.
    const pollIdx = CLIENT.indexOf("async function poll()");
    expect(pollIdx, "event-client: a poll() function exists").toBeGreaterThan(-1);
    const pollBody = CLIENT.slice(pollIdx, pollIdx + 320);
    expect(
      /setUnlockState/.test(pollBody),
      "event-client: the polling loop must NOT set unlockState (no loading/retry chrome on background polls)",
    ).toBe(false);

    // The loading/failed UI is gated strictly on the unlockState value, so an idle (polling)
    // state shows neither.
    expect(
      /unlockState === "loading"/.test(CLIENT) && /unlockState === "failed"/.test(CLIENT),
      "event-client: the loading/retry UI is gated on unlockState (idle ⇒ nothing)",
    ).toBe(true);
  });

  it("the loading/failed/retry copy exists in BOTH the en and zh catalogs (no missing-key fallback)", () => {
    const en = JSON.parse(src("messages/en.json")).eventPage;
    const zh = JSON.parse(src("messages/zh.json")).eventPage;
    for (const [name, m] of [["en", en], ["zh", zh]] as const) {
      for (const key of ["unlockLoading", "unlockFailed", "unlockRetry"]) {
        expect(
          typeof m?.[key] === "string" && m[key].length > 0,
          `${name}.${key} present and non-empty`,
        ).toBe(true);
      }
    }
  });
});

describe("Batch 6 M26: waitlist framing is derived from isFull && !viewerIsGoing", () => {
  const FORM = src("components/events/rsvp-form.tsx");

  it("framesWaitlist = isFull && !viewerIsGoing (a viewer already going is NOT relabelled)", () => {
    expect(
      /framesWaitlist\s*=\s*isFull\s*&&\s*!viewerIsGoing/.test(FORM),
      "rsvp-form: the waitlist framing is gated on the viewer NOT already going",
    ).toBe(true);
  });

  it("viewerIsGoing prefers the server-confirmed status over the cached one", () => {
    // The confirmed (server) status must win over the cached `initial` one, so a viewer who
    // just confirmed 'going' is immediately treated as holding a seat.
    expect(
      /viewerIsGoing\s*=\s*\(confirmed\?\.status\s*\?\?\s*initial\?\.status\)\s*===\s*"going"/.test(FORM),
      "rsvp-form: viewerIsGoing derives from confirmed?.status ?? initial?.status === 'going'",
    ).toBe(true);
  });

  it("the 'going' button is only relabelled to Join waitlist via framesWaitlist (not raw isFull)", () => {
    // The button label must key off framesWaitlist, NOT a bare isFull — otherwise a going
    // viewer's own re-confirm button would lie ("Join waitlist") about costing their seat.
    expect(
      /s === "going" && framesWaitlist \? t\("joinWaitlist"\)/.test(FORM),
      "rsvp-form: the going button uses framesWaitlist for the Join-waitlist label",
    ).toBe(true);
    // The intro copy is likewise gated on framesWaitlist, not raw isFull.
    expect(
      /framesWaitlist \? t\("introFull"\) : t\("intro"\)/.test(FORM),
      "rsvp-form: the full/normal intro picks on framesWaitlist",
    ).toBe(true);
    // Guard against a regression to raw isFull in the user-facing label/intro: the literal
    // `isFull ? t("joinWaitlist")` (without the !viewerIsGoing guard) must NOT appear.
    expect(
      /isFull \? t\("joinWaitlist"\)/.test(FORM),
      "rsvp-form: must NOT relabel on raw isFull (that would mislabel a going viewer)",
    ).toBe(false);
  });

  it("the joinWaitlist label exists in BOTH the en and zh catalogs", () => {
    const en = JSON.parse(src("messages/en.json")).rsvp;
    const zh = JSON.parse(src("messages/zh.json")).rsvp;
    for (const [name, m] of [["en", en], ["zh", zh]] as const) {
      expect(typeof m?.joinWaitlist === "string" && m.joinWaitlist.length > 0, `${name}.joinWaitlist present`).toBe(true);
      expect(typeof m?.introFull === "string" && m.introFull.length > 0, `${name}.introFull present`).toBe(true);
    }
  });
});
