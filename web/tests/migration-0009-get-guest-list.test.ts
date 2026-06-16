import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.5c [SECURITY] — `get_guest_list`, the desensitized + unlock-gated guest
 * list read path (migration 0009_get_guest_list.sql, logical "0005d";
 * TEST-SPEC §1.5c).
 *
 * Written by the INDEPENDENT test agent (never wrote the implementation) with the
 * stance "assume this RPC leaks contact, exposes guest_id/token, shows declines or
 * the waitlist, or hands the list to someone who never RSVP'd". `anon` has NO
 * direct privilege on guests/rsvps (0004/0005), so the SECOND-TIER guest list
 * reaches a guest ONLY through this one SECURITY DEFINER function — a single
 * missing branch leaks a host-only contact, the internal guest_id/token, the
 * Can't-Go list, or the whole roster to an un-RSVP'd stranger. The pinned contract
 * (SCHEMA "get_guest_list" + 安全模型 §1 单一读路径; D5/D15; G1/G4) is hammered from
 * every angle:
 *
 *   1. DESENSITIZATION (D15, 第三类 never leaks). Each entry exposes ONLY
 *      display_name / status / plus_ones — the keys guest_id / guest_token /
 *      contact / user_id / event_id simply DO NOT EXIST in the result (structural
 *      omission, asserted by exact-key equality, not a value check). A host-only
 *      sentinel contact and every seeded guest_token must never appear anywhere in
 *      the JSON.
 *   2. STATUS FILTER. ONLY Going/Maybe surface. Can't-Go (not_going) is NEVER
 *      shown; Waitlisted is NEVER shown (the waitlist is the host's own single
 *      column, not this public list) — even when the unlocked caller IS the
 *      waitlisted guest, they see Going/Maybe but not the waitlist (incl. not
 *      themselves).
 *   3. UNLOCK GATE (G4, reuses guest_unlock_status). No token / forged token /
 *      cross-event token / a not_going RSVP ⇒ NO list. A real Going OR Maybe OR
 *      Waitlisted token unlocks; a logged-in caller unlocks via their linked
 *      account (user_id) with NO token (cross-device). The event's own HOST does
 *      NOT get the list here unless they RSVP'd — the host roster is a separate
 *      RLS path, not this RPC.
 *   4. hide_guest_list. With the flag on, NOBODY gets the list on this read path —
 *      even a fully-unlocked caller gets [].
 *   5. NO ORACLE. Hidden / locked / cross-event / unknown-slug / empty all return
 *      the SAME empty array (TEST-SPEC §1.5c "返回空/被拒" — '[]' satisfies 空), so
 *      the caller cannot distinguish "hidden" from "locked" from "nobody going".
 *   6. SINGLE READ PATH (G1). anon still cannot SELECT guests/rsvps directly — the
 *      RPC is the only way the list is ever reachable.
 *
 * Calls go over PostgREST (.rpc) on the real role paths — anon presents a token,
 * an authenticated session exercises the account/user_id branch, service is the
 * trusted SSR path that forwards the guest's token — because auth.uid() only
 * reflects the caller's JWT over that wire. Seeding is done as the postgres
 * superuser (psql): with Supabase auto-expose OFF, anon/service have no API grant
 * on events/guests/rsvps so PostgREST can't INSERT them; only the SECURITY DEFINER
 * RPC can. Same pattern as the 1.1–1.5b suites. Gated on a reachable local stack so
 * the file skips (green) without Docker; where the stack IS up, the gate must
 * really hold.
 */
const LOCAL_UP = localStackRunning();

const FN = "get_guest_list";

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

/** Last non-empty line of psql `-At` output (the value of a single-column row). */
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

// A PostgREST response, structurally — { data, error } is all we read.
type ApiResult = { data: unknown; error: { message?: string } | null };
/** A desensitized list entry — the ONLY three keys that may ever appear (D15). */
interface GuestEntry {
  display_name: string;
  status: string;
  plus_ones: number;
}
/** The exact, complete key set of one entry. Anything more is a third-tier leak. */
const ALLOWED_KEYS = ["display_name", "plus_ones", "status"]; // sorted

// ── Sentinels — unique enough to prove a specific value never crosses a boundary.
const PREFIX = "t15c"; // cleanup deletes every event whose title/slug starts here
const SENTINEL_CONTACT = "t15c-contact-secret@sentinel.invalid"; // host-only; must NEVER appear

// Per-scenario events (separate so each scenario's roster is isolated).
const E_LIST = "t15c-list"; // public, list shown — the main going/maybe roster + decline/waitlist
const E_HIDDEN = "t15c-hidden"; // hide_guest_list=true — list withheld even when unlocked
const E_CROSS_A = "t15c-cross-a"; // a token lives here…
const E_CROSS_B = "t15c-cross-b"; // …and is replayed against here (event-scoped gate)
const E_ACCOUNT = "t15c-account"; // account/user_id unlock branch (no token, cross-device)
const E_EMPTY = "t15c-empty"; // unlocked caller but nobody going/maybe ⇒ []

// Fixed guest_token uuids so forged / cross-event / pre-seeded probes are deterministic.
const T_GOING = "15c00000-0000-4000-8000-000000000001"; // E_LIST: going +2, carries the sentinel contact
const T_MAYBE = "15c00000-0000-4000-8000-000000000002"; // E_LIST: maybe +0 (also unlocks; also listed)
const T_NOTGOING = "15c00000-0000-4000-8000-000000000003"; // E_LIST: not_going (does NOT unlock, NOT listed)
const T_WAIT = "15c00000-0000-4000-8000-000000000004"; // E_LIST: waitlisted (unlocks, but NOT listed)
const T_ERIN = "15c00000-0000-4000-8000-000000000005"; // E_LIST: going +1 (third going attendee)
const T_HIDDEN = "15c00000-0000-4000-8000-000000000006"; // E_HIDDEN: going (would unlock, but list hidden)
const T_HIDDEN2 = "15c00000-0000-4000-8000-000000000007"; // E_HIDDEN: another going
const T_CROSS = "15c00000-0000-4000-8000-000000000008"; // E_CROSS_A: going (replayed on E_CROSS_B)
const T_CROSSB = "15c00000-0000-4000-8000-000000000009"; // E_CROSS_B: going (B's own valid unlock)
const T_ACCT = "15c00000-0000-4000-8000-00000000000a"; // E_ACCOUNT: going, linked to host B's account
const T_ACCT2 = "15c00000-0000-4000-8000-00000000000b"; // E_ACCOUNT: another going (no account link)
const T_EMPTY = "15c00000-0000-4000-8000-00000000000c"; // E_EMPTY: waitlisted (unlocks; nobody to list)
const T_FORGED = "15c00000-0000-4000-8000-0000000000ff"; // valid uuid, never inserted

// Every seeded token — none may ever appear in any returned list body (第三类).
const ALL_TOKENS = [
  T_GOING, T_MAYBE, T_NOTGOING, T_WAIT, T_ERIN, T_HIDDEN, T_HIDDEN2,
  T_CROSS, T_CROSSB, T_ACCT, T_ACCT2, T_EMPTY,
];

// Display names that must NEVER appear in any visible list.
const NAME_NOTGOING = "t15c-carol-notgoing"; // Can't-Go must never show
const NAME_WAIT = "t15c-dave-waitlisted"; // waitlist must never show on this path

describe("task 1.5c [SECURITY]: get_guest_list desensitized + gated read (TEST-SPEC §1.5c)", () => {
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
  /** Authenticated path — caller's JWT, so auth.uid() = host.id inside the definer. */
  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  /** Call get_guest_list over PostgREST; omit token to leave it at its SQL default. */
  async function callList(
    client: SupabaseClient,
    slug: string,
    token?: string,
  ): Promise<{ res: ApiResult; data: GuestEntry[] | null }> {
    const body: Record<string, unknown> = { slug };
    if (token !== undefined) body.guest_token = token;
    const res = (await client.rpc(FN, body)) as ApiResult;
    return { res, data: (res.data as GuestEntry[]) ?? null };
  }

  /** Assert a successful, structurally-empty list (the no-oracle outcome). */
  function expectEmptyList(r: { res: ApiResult; data: GuestEntry[] | null }, label: string): void {
    expect(r.res.error, `${label}: ${JSON.stringify(r.res.error)}`).toBeNull();
    expect(Array.isArray(r.data), `${label}: result is a jsonb array`).toBe(true);
    expect(r.data?.length, `${label}: empty list (空) — no roster revealed`).toBe(0);
  }

  /** Assert every entry is fully desensitized: exactly the 3 allowed keys, no third
   *  tier anywhere, only going/maybe, and no seeded token/contact rides along. */
  function expectDesensitized(data: GuestEntry[] | null, label: string): void {
    expect(Array.isArray(data), `${label}: array`).toBe(true);
    const list = data ?? [];
    const json = JSON.stringify(list);
    // No third-tier value ever leaks into the body.
    expect(json, `${label}: host-only contact must never ride along`).not.toContain(SENTINEL_CONTACT);
    for (const tok of ALL_TOKENS) {
      expect(json, `${label}: guest_token ${tok} must never appear`).not.toContain(tok);
    }
    // Hidden/declined identities never appear.
    expect(json, `${label}: Can't-Go guest must never appear`).not.toContain(NAME_NOTGOING);
    expect(json, `${label}: waitlisted guest must never appear on this path`).not.toContain(NAME_WAIT);
    for (const entry of list) {
      // Exact key set — guest_id/guest_token/contact/user_id/event_id structurally absent.
      expect(Object.keys(entry).sort(), `${label}: entry exposes ONLY display_name/status/plus_ones`)
        .toEqual(ALLOWED_KEYS);
      // Only going/maybe — not_going and waitlisted are filtered out.
      expect(["going", "maybe"], `${label}: status is going|maybe only (no not_going/waitlisted)`)
        .toContain(entry.status);
      expect(typeof entry.display_name, `${label}: display_name is a string`).toBe("string");
      expect(typeof entry.plus_ones, `${label}: plus_ones is a number`).toBe("number");
    }
  }

  /** The set of display_names in a list (order-independent membership checks). */
  function names(data: GuestEntry[] | null): string[] {
    return (data ?? []).map((e) => e.display_name).sort();
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();
    expect(hostB?.id, "need >=2 host sessions (host B, for the account/user_id branch)").toBeTruthy();

    // Signature is pinned (SCHEMA RPC table): (slug, guest_token). The independent
    // test relies on these exact arg names for its .rpc bodies; a rename/reorder is
    // itself a contract break.
    expect(inArgNames(FN), "get_guest_list signature is pinned").toEqual(["slug", "guest_token"]);

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);

    // Host profiles back the guests.user_id FK; the auth.users trigger creates them,
    // upsert defensively regardless of trigger timing.
    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't15c host A'), ('${hostB.id}', 't15c host B')
         on conflict (id) do nothing;`,
    );

    // Events. hide_guest_list varies per scenario; everything else takes its default.
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, capacity, allow_plus_ones, max_plus_ones, hide_guest_list) values
         ('${hostA.id}','${E_LIST}',    't15c list',    'public','published', null, true, 3, false),
         ('${hostA.id}','${E_HIDDEN}',  't15c hidden',  'public','published', null, true, 3, true),
         ('${hostA.id}','${E_CROSS_A}', 't15c cross a', 'public','published', null, true, 3, false),
         ('${hostA.id}','${E_CROSS_B}', 't15c cross b', 'public','published', null, true, 3, false),
         ('${hostA.id}','${E_ACCOUNT}', 't15c account', 'public','published', null, true, 3, false),
         ('${hostA.id}','${E_EMPTY}',   't15c empty',   'public','published', null, true, 3, false);`,
    );

    // Guests. E_LIST holds the full mix: two going, one maybe, one not_going, one
    // waitlisted. The going guest carries the sentinel contact (a leak would surface
    // it). E_ACCOUNT's first guest is linked to host B's account (user_id) so the
    // no-token account branch can unlock cross-device.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact, user_id) values
         ((select id from public.events where slug='${E_LIST}'),    '${T_GOING}'::uuid,    't15c-alice-going',     '${SENTINEL_CONTACT}', null),
         ((select id from public.events where slug='${E_LIST}'),    '${T_MAYBE}'::uuid,    't15c-bob-maybe',       null, null),
         ((select id from public.events where slug='${E_LIST}'),    '${T_NOTGOING}'::uuid, '${NAME_NOTGOING}',     null, null),
         ((select id from public.events where slug='${E_LIST}'),    '${T_WAIT}'::uuid,     '${NAME_WAIT}',         null, null),
         ((select id from public.events where slug='${E_LIST}'),    '${T_ERIN}'::uuid,     't15c-erin-going',      null, null),
         ((select id from public.events where slug='${E_HIDDEN}'),  '${T_HIDDEN}'::uuid,   't15c-hidden-g1',       null, null),
         ((select id from public.events where slug='${E_HIDDEN}'),  '${T_HIDDEN2}'::uuid,  't15c-hidden-g2',       null, null),
         ((select id from public.events where slug='${E_CROSS_A}'), '${T_CROSS}'::uuid,    't15c-crossA-going',    null, null),
         ((select id from public.events where slug='${E_CROSS_B}'), '${T_CROSSB}'::uuid,   't15c-crossB-going',    null, null),
         ((select id from public.events where slug='${E_ACCOUNT}'), '${T_ACCT}'::uuid,     't15c-acct-guest',      null, '${hostB.id}'),
         ((select id from public.events where slug='${E_ACCOUNT}'), '${T_ACCT2}'::uuid,    't15c-acct-other',      null, null),
         ((select id from public.events where slug='${E_EMPTY}'),   '${T_EMPTY}'::uuid,    't15c-empty-wait',      null, null);`,
    );

    // RSVPs — status + plus_ones keyed by the guest's deterministic token.
    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_GOING}'::uuid    then 'going'
             when '${T_MAYBE}'::uuid    then 'maybe'
             when '${T_NOTGOING}'::uuid then 'not_going'
             when '${T_WAIT}'::uuid     then 'waitlisted'
             when '${T_ERIN}'::uuid     then 'going'
             when '${T_HIDDEN}'::uuid   then 'going'
             when '${T_HIDDEN2}'::uuid  then 'going'
             when '${T_CROSS}'::uuid    then 'going'
             when '${T_CROSSB}'::uuid   then 'going'
             when '${T_ACCT}'::uuid     then 'going'
             when '${T_ACCT2}'::uuid    then 'going'
             when '${T_EMPTY}'::uuid    then 'waitlisted'
           end,
           case g.guest_token
             when '${T_GOING}'::uuid then 2
             when '${T_ERIN}'::uuid  then 1
             else 0
           end
         from public.guests g
         where g.guest_token in (
           '${T_GOING}'::uuid,'${T_MAYBE}'::uuid,'${T_NOTGOING}'::uuid,'${T_WAIT}'::uuid,'${T_ERIN}'::uuid,
           '${T_HIDDEN}'::uuid,'${T_HIDDEN2}'::uuid,'${T_CROSS}'::uuid,'${T_CROSSB}'::uuid,
           '${T_ACCT}'::uuid,'${T_ACCT2}'::uuid,'${T_EMPTY}'::uuid
         );`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    // ON DELETE CASCADE clears seeded guests/rsvps with the event.
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  // ── §1.5c — the desensitized happy path: only going/maybe, only 3 safe fields ────
  it.skipIf(!LOCAL_UP)(
    "an unlocked going caller sees ONLY going/maybe with ONLY display_name/status/plus_ones — no contact, no guest_id, no token, no Can't-Go, no waitlist",
    async () => {
      const r = await callList(anon(), E_LIST, T_GOING);
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expectDesensitized(r.data, "going-caller");

      // Exactly the two going (alice, erin) + the one maybe (bob) — NOT carol
      // (not_going) and NOT dave (waitlisted).
      expect(r.data?.length, "3 visible: 2 going + 1 maybe (decline + waitlist excluded)").toBe(3);
      expect(names(r.data), "exactly alice/bob/erin").toEqual(
        ["t15c-alice-going", "t15c-bob-maybe", "t15c-erin-going"],
      );

      // Field-level correctness: plus_ones and status are carried verbatim.
      const byName = new Map((r.data ?? []).map((e) => [e.display_name, e]));
      expect(byName.get("t15c-alice-going")?.status).toBe("going");
      expect(byName.get("t15c-alice-going")?.plus_ones, "alice going +2").toBe(2);
      expect(byName.get("t15c-bob-maybe")?.status).toBe("maybe");
      expect(byName.get("t15c-bob-maybe")?.plus_ones, "bob maybe +0").toBe(0);
      expect(byName.get("t15c-erin-going")?.plus_ones, "erin going +1").toBe(1);
    },
  );

  // ── §1.5c — a MAYBE token unlocks the same list (maybe is in the unlock set) ─────
  it.skipIf(!LOCAL_UP)(
    "a maybe-RSVP token unlocks the list too, and the list is identical (no Can't-Go / no waitlist)",
    async () => {
      const r = await callList(anon(), E_LIST, T_MAYBE);
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expectDesensitized(r.data, "maybe-caller");
      expect(names(r.data), "maybe caller sees the same going/maybe roster").toEqual(
        ["t15c-alice-going", "t15c-bob-maybe", "t15c-erin-going"],
      );
    },
  );

  // ── §1.5c 更狠 — a WAITLISTED caller is unlocked, but the waitlist is NEVER shown ─
  it.skipIf(!LOCAL_UP)(
    "a waitlisted caller is unlocked (helper) yet sees ONLY going/maybe — the waitlist (incl. themselves) is never on this path",
    async () => {
      const r = await callList(anon(), E_LIST, T_WAIT);
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expectDesensitized(r.data, "waitlisted-caller");
      // Unlocked, so the going/maybe roster appears — but dave (waitlisted, the
      // caller) and carol (not_going) are filtered out.
      expect(names(r.data), "waitlisted caller still sees only going/maybe").toEqual(
        ["t15c-alice-going", "t15c-bob-maybe", "t15c-erin-going"],
      );
    },
  );

  // ── §1.5c — a NOT_GOING token does NOT unlock (a decliner gets no roster) ────────
  it.skipIf(!LOCAL_UP)(
    "a not_going caller is NOT unlocked ⇒ empty list (a decline must not reveal the roster)",
    async () => {
      expectEmptyList(await callList(anon(), E_LIST, T_NOTGOING), "not_going-caller");
    },
  );

  // ── §1.5c — locked callers (no token / forged / cross-event) ⇒ no roster ─────────
  it.skipIf(!LOCAL_UP)(
    "no token, a forged token, and a cross-event token all yield an empty list (unlock required, event-scoped)",
    async () => {
      // No token at all.
      expectEmptyList(await callList(anon(), E_LIST), "no-token");
      // Forged token (valid uuid, matches no guest).
      expectEmptyList(await callList(anon(), E_LIST, T_FORGED), "forged-token");
      // Cross-event: E_CROSS_A's going token presented against E_LIST.
      expectEmptyList(await callList(anon(), E_LIST, T_CROSS), "cross-event-on-E_LIST");
    },
  );

  // ── §1.5c — cross-event scope: A's token on B is rejected; B's own token works ───
  it.skipIf(!LOCAL_UP)(
    "event A's token replayed on event B ⇒ empty (event-scoped gate); B's own token ⇒ B's roster (proves the [] is scope, not emptiness)",
    async () => {
      // Replay: T_CROSS belongs to E_CROSS_A, presented to E_CROSS_B ⇒ no unlock ⇒ [].
      expectEmptyList(await callList(anon(), E_CROSS_B, T_CROSS), "cross-A-token-on-B");

      // Control: E_CROSS_B's OWN valid token DOES unlock B's roster — so the empty
      // result above is the cross-event scope rejection, not just an empty event.
      const own = await callList(anon(), E_CROSS_B, T_CROSSB);
      expect(own.res.error, JSON.stringify(own.res.error)).toBeNull();
      expectDesensitized(own.data, "B-own-token");
      expect(names(own.data), "B's own token reveals B's going roster").toEqual(["t15c-crossB-going"]);
    },
  );

  // ── §1.5c — hide_guest_list=true ⇒ nobody gets the list, even fully unlocked ─────
  it.skipIf(!LOCAL_UP)(
    "hide_guest_list=true ⇒ empty list even for an unlocked (going) caller",
    async () => {
      // T_HIDDEN is a real going RSVP on E_HIDDEN, so the caller IS unlocked — yet
      // the host hid the list, so this read path still returns [].
      expectEmptyList(await callList(anon(), E_HIDDEN, T_HIDDEN), "hidden-list-unlocked-caller");
      // And of course an un-unlocked caller gets [] too.
      expectEmptyList(await callList(anon(), E_HIDDEN), "hidden-list-no-token");
    },
  );

  // ── §1.5c — account (user_id) unlock branch: logged in, NO token, cross-device ───
  it.skipIf(!LOCAL_UP)(
    "a logged-in caller WITHOUT a token unlocks via their linked account (user_id) and sees the roster",
    async () => {
      // Host B's account is linked to a guest on E_ACCOUNT — so host B, presenting NO
      // token, unlocks via guests.user_id = auth.uid() (换设备凭账号认回).
      const r = await callList(asHost(hostB.accessToken), E_ACCOUNT);
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expectDesensitized(r.data, "account-unlock");
      expect(names(r.data), "both going guests on E_ACCOUNT are listed").toEqual(
        ["t15c-acct-guest", "t15c-acct-other"],
      );
    },
  );

  // ── §1.5c 更狠 — the EVENT OWNER does NOT get the list via this RPC without RSVP ──
  it.skipIf(!LOCAL_UP)(
    "the event's own host (not an RSVP'd guest) gets an empty list here — the host roster is a separate RLS path, not this RPC",
    async () => {
      // Host A owns E_ACCOUNT but never RSVP'd to it, so the unlock helper finds no
      // matching guest for auth.uid() ⇒ []. (host A also gets [] as anon would.)
      expectEmptyList(await callList(asHost(hostA.accessToken), E_ACCOUNT), "owner-host-no-rsvp");
      // An anonymous caller with no token is likewise empty.
      expectEmptyList(await callList(anon(), E_ACCOUNT), "anon-no-token");
    },
  );

  // ── §1.5c — unlocked but nobody going/maybe ⇒ empty (no error, no oracle) ────────
  it.skipIf(!LOCAL_UP)(
    "an unlocked caller on an event whose only RSVP is waitlisted ⇒ empty list (unlocked ≠ error; waitlist not surfaced)",
    async () => {
      // T_EMPTY is waitlisted ⇒ the caller IS unlocked, but the only RSVP is their
      // own waitlist entry, which is filtered out ⇒ [] (same shape as hidden/locked).
      expectEmptyList(await callList(anon(), E_EMPTY, T_EMPTY), "unlocked-but-empty");
    },
  );

  // ── §1.5c — unknown slug is not an existence oracle ──────────────────────────────
  it.skipIf(!LOCAL_UP)(
    "unknown slug ⇒ empty list (same shape as hidden/locked — no existence oracle)",
    async () => {
      expectEmptyList(await callList(anon(), "t15c-does-not-exist-xyz", T_GOING), "unknown-slug");
    },
  );

  // ── §1.5c — the trusted SSR path forwards the guest's token, inheriting the gate ─
  it.skipIf(!LOCAL_UP)(
    "service_role gets the roster ONLY when it forwards a valid unlock token (service alone does not unlock)",
    async () => {
      // SSR with the guest's token relayed: same unlock decision ⇒ roster appears.
      const withTok = await callList(service(), E_LIST, T_GOING);
      expect(withTok.res.error, JSON.stringify(withTok.res.error)).toBeNull();
      expectDesensitized(withTok.data, "ssr-with-token");
      expect(names(withTok.data), "SSR forwarding a going token sees the roster").toEqual(
        ["t15c-alice-going", "t15c-bob-maybe", "t15c-erin-going"],
      );

      // service_role WITHOUT a token does not magically unlock — the gate is the
      // guest's RSVP, not the caller's privilege.
      expectEmptyList(await callList(service(), E_LIST), "ssr-no-token");
    },
  );

  // ── §1.5c (G1) — anon still has NO direct table read: the RPC is the only path ───
  it.skipIf(!LOCAL_UP)(
    "anon cannot SELECT guests/rsvps directly — get_guest_list is the ONLY way the roster is reachable (G1)",
    async () => {
      const an = anon();
      const evId = scalar(runSql(`select id from public.events where slug='${E_LIST}';`));

      // Direct table reads must return nothing (no grant/policy for anon). PostgREST
      // surfaces this as either an error or an empty set — both prove "no leak".
      const g = await an.from("guests").select("*").eq("event_id", evId);
      expect((g.data ?? []).length, "anon direct SELECT on guests must leak no rows").toBe(0);
      const r = await an.from("rsvps").select("*").eq("event_id", evId);
      expect((r.data ?? []).length, "anon direct SELECT on rsvps must leak no rows").toBe(0);

      // Belt-and-braces: the host-only contact is unreachable by anon via any table.
      const c = await an.from("guests").select("contact").eq("event_id", evId);
      expect(JSON.stringify(c.data ?? []), "anon must not read any contact").not.toContain(SENTINEL_CONTACT);
    },
  );
});
