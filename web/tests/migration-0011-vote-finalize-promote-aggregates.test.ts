import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.5e [SECURITY] — the date-poll write path + the two HOST-ONLY mutations +
 * the two aggregate reads (migration 0011_vote_finalize_promote_aggregates.sql,
 * logical "0005f"; TEST-SPEC §1.5e):
 *   vote_dates / finalize_date / promote_guest / get_my_events /
 *   get_public_events_by_host.
 *
 * Written by the INDEPENDENT test agent (never wrote the implementation) with the
 * stance "assume a stranger can finalize someone's date, a service-role cron can
 * promote past capacity, a guest can vote without RSVPing, a cross-event token
 * still counts, the dashboard leaks another host's events, and the organizer page
 * exposes a private/draft event or a full street address." Every guest read/write
 * of these tables reaches them ONLY through a SECURITY DEFINER RPC (anon/authenticated
 * have NO direct privilege — 0004/0005), so a single missing branch is a real breach.
 * The pinned contract (SCHEMA 安全模型 §1/§2 单一读/写路径; D1/D2/D7③; G1) is hammered:
 *
 *   1. HOST-ONLY, REAL AUTH CONTEXT (D7③). finalize_date / promote_guest must reject
 *      a non-host AND — the subtle one — a service-role / no-JWT caller, whose
 *      auth.uid() is NULL (so `host_id <> auth.uid()` is NULL, i.e. NOT raised). The
 *      explicit null guard is what stops a service-role call from finalizing/promoting.
 *      Probed live: a service-role finalize returns 42501 "authentication required",
 *      a non-host returns 42501 "only the host can …". Both are asserted, and the DB
 *      state is asserted UNCHANGED (the stronger claim).
 *   2. VOTES SURVIVE FINALIZE (保留投票记录, D7③). finalize_date only writes
 *      events.starts_at/ends_at + date_tbd=false; date_options / date_votes are kept.
 *   3. CAPACITY RESPECTED, RACE-SAFE (D7①). promote_guest counts going occupancy
 *      (incl. plus-ones) under the same per-event advisory lock submit_rsvp uses and
 *      refuses when the seat doesn't fit; only a waitlisted row can be promoted.
 *   4. VOTE GATE = the shared helper ONLY (G4). vote_dates needs an UNLOCKED RSVP
 *      (going/maybe/waitlisted). No token / forged / cross-event / not_going ⇒ rejected.
 *      The author guest_id is RESOLVED server-side from the verified token — never sent.
 *   5. MULTI-SELECT UPSERT, EVENT-SCOPED (去掉未选项). The passed option_ids become the
 *      guest's COMPLETE selection (de-selected options removed); a foreign/forged
 *      option_id is silently dropped and the delete can never reach another event's votes.
 *   6. get_my_events (D1): events I HOST (host_id) ∪ events I ATTEND (guests.user_id),
 *      each once, role-discriminated — and NEVER another user's events. Desensitized
 *      list view (location_city, never the full location_text).
 *   7. get_public_events_by_host (D2): ONLY a host's public+published events — never
 *      private / draft / cancelled, never another host's — served to anon WITHOUT any
 *      direct table grant (G1).
 *
 * Calls go over PostgREST (.rpc) on the real role paths — anon presents a token, an
 * authenticated session carries auth.uid() for the host / attend branches, service is
 * the trusted SSR path — because auth.uid()/auth.role() only reflect the caller's JWT
 * over that wire (the live probe confirmed the exact error/return shapes used below:
 * PostgREST surfaces a raised exception as {code: SQLSTATE, message}). Seeding is done
 * as the postgres superuser (psql): with auto-expose OFF, anon/service have no API
 * grant on the client-data tables, so only the DEFINER RPC can reach them — same
 * pattern as the 1.1–1.5d suites. Gated on a reachable local stack so the file skips
 * (green) without Docker; where the stack IS up, the gate must really hold.
 */
const LOCAL_UP = localStackRunning();

const FN_VOTE = "vote_dates";
const FN_FINALIZE = "finalize_date";
const FN_PROMOTE = "promote_guest";
const FN_MINE = "get_my_events";
const FN_PUBLIC = "get_public_events_by_host";

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

/** id (uuid) of a seeded event by slug. */
function eventId(slug: string): string {
  return scalar(runSql(`select id from public.events where slug='${slug}';`));
}
/** guest_id behind a deterministic token. */
function guestIdOf(token: string): string {
  return scalar(runSql(`select id from public.guests where guest_token='${token}'::uuid;`));
}
/** The rsvp id for a deterministic token (promote_guest takes rsvp_id). */
function rsvpIdByToken(token: string): string {
  return scalar(
    runSql(
      `select r.id from public.rsvps r join public.guests g on g.id=r.guest_id
         where g.guest_token='${token}'::uuid;`,
    ),
  );
}
/** Current rsvp status for a token (the promote/no-mutation assertions read this). */
function rsvpStatusByToken(token: string): string {
  return scalar(
    runSql(
      `select r.status from public.rsvps r join public.guests g on g.id=r.guest_id
         where g.guest_token='${token}'::uuid;`,
    ),
  );
}
/** events.starts_at (or '<null>') — finalize must write it / leave it untouched. */
function eventStartsAt(slug: string): string {
  return scalar(runSql(`select coalesce(starts_at::text,'<null>') from public.events where slug='${slug}';`));
}
/** events.date_tbd — finalize clears it; the reject paths must leave it true. */
function eventDateTbd(slug: string): string {
  return scalar(runSql(`select date_tbd from public.events where slug='${slug}';`));
}
/** Count of all date_votes on an event (through its options) — finalize keeps these. */
function eventVoteCount(slug: string): number {
  return Number(
    scalar(
      runSql(
        `select count(*) from public.date_votes dv
           join public.date_options o on o.id=dv.date_option_id
           join public.events e on e.id=o.event_id where e.slug='${slug}';`,
      ),
    ),
  );
}
/** The exact set of option-ids a guest (by token) currently has votes for (sorted). */
function guestVoteOptionIds(token: string): string[] {
  const raw = scalar(
    runSql(
      `select coalesce(array_agg(dv.date_option_id::text order by dv.date_option_id::text), '{}')
         from public.date_votes dv join public.guests g on g.id=dv.guest_id
        where g.guest_token='${token}'::uuid;`,
    ),
  );
  const inner = raw.replace(/^\{/, "").replace(/\}$/, "").trim();
  return inner ? inner.split(",").map((s) => s.replace(/"/g, "").trim()).sort() : [];
}

// A PostgREST response, structurally — { data, error } is all we read.
type ApiResult = { data: unknown; error: { message?: string; code?: string } | null };

// ── Sentinels — a value that must NEVER cross a tier boundary in an aggregate read.
const PREFIX = "t15e"; // cleanup deletes every event whose slug starts here
const SENTINEL_LOC = "t15e-FULL-ADDRESS-must-not-leak"; // second-tier location_text
const CITY_A = "t15e-city-public-a"; // first-tier location_city (may appear)
const UNAME_A = "t15e-uname-a";
const UNAME_B = "t15e-uname-b";

// Events (one per isolated scenario so counters/states never bleed across tests).
const E_POLL = "t15e-poll"; // vote_dates main poll (date_tbd)
const E_POLL2 = "t15e-poll2"; // foreign-option + cross-event vote isolation
const E_VCANCEL = "t15e-vcancel"; // cancelled — vote refused
const E_FIN = "t15e-fin"; // finalize SUCCESS target (votes must survive)
const E_FIN_REJ = "t15e-fin-rej"; // finalize host-only + cross-option REJECT (never mutated)
const E_PROMO_OK = "t15e-promo-ok"; // promote success (cap 3, fits)
const E_PROMO_FULL = "t15e-promo-full"; // promote capacity REJECT (cap 2, full) + already-going
const E_PROMO_UNLIM = "t15e-promo-unlim"; // promote success (cap NULL = unlimited)
const E_PROMO_PLUS = "t15e-promo-plus"; // promote success counting plus_ones (cap 4)
const E_PROMO_REJ = "t15e-promo-rej"; // promote host-only REJECT (never mutated)
const E_A_PUBPUB = "t15e-a-pubpub"; // host A public+published (get_my host + get_public include)
const E_A_PRIVATE = "t15e-a-private"; // host A private — get_public EXCLUDE
const E_A_DRAFT = "t15e-a-draft"; // host A public draft — get_public EXCLUDE
const E_A_CANCEL = "t15e-a-cancel"; // host A public cancelled — get_public EXCLUDE
const E_A_BOTH = "t15e-a-both"; // host A + A is also a guest — get_my role=host, once
const E_B_ATTEND = "t15e-b-attend"; // host B, A attends (user_id) — get_my(A) role=guest
const E_B_OTHER = "t15e-b-other"; // host B, A does NOT attend — get_my(A) EXCLUDE; get_public(B) include

// Fixed date_option ids (passed directly to vote_dates / finalize_date).
const O1 = "15e0a000-0000-4000-8000-000000000001"; // E_POLL
const O2 = "15e0a000-0000-4000-8000-000000000002"; // E_POLL
const O3 = "15e0a000-0000-4000-8000-000000000003"; // E_POLL2 (FOREIGN to E_POLL)
const FO1 = "15e0a000-0000-4000-8000-000000000011"; // E_FIN (the chosen one)
const FO2 = "15e0a000-0000-4000-8000-000000000012"; // E_FIN
const FRO1 = "15e0a000-0000-4000-8000-000000000031"; // E_FIN_REJ (a valid option so the
//                                                       host-only/no-auth gates are reached,
//                                                       not an arg-cast error)
const VCO = "15e0a000-0000-4000-8000-000000000021"; // E_VCANCEL

// Fixed guest_token uuids (deterministic forged/cross-event/seed probes).
const T_VOTE_GOING = "15e1b000-0000-4000-8000-000000000001"; // E_POLL going — primary voter
const T_VOTE_MAYBE = "15e1b000-0000-4000-8000-000000000002"; // E_POLL maybe — unlocks
const T_VOTE_WAIT = "15e1b000-0000-4000-8000-000000000003"; // E_POLL waitlisted — unlocks
const T_VOTE_NOTGO = "15e1b000-0000-4000-8000-000000000004"; // E_POLL not_going — does NOT unlock
const T_VOTE2 = "15e1b000-0000-4000-8000-000000000005"; // E_POLL2 going — owns the O3 vote
const T_VCANCEL = "15e1b000-0000-4000-8000-000000000006"; // E_VCANCEL going — yet event cancelled
const T_FIN = "15e1b000-0000-4000-8000-000000000007"; // E_FIN going — owns the surviving vote
const T_OK_G1 = "15e1b000-0000-4000-8000-000000000010"; // E_PROMO_OK going
const T_OK_G2 = "15e1b000-0000-4000-8000-000000000011"; // E_PROMO_OK going
const T_OK_W = "15e1b000-0000-4000-8000-000000000012"; // E_PROMO_OK waitlisted — promoted
const T_FULL_G1 = "15e1b000-0000-4000-8000-000000000020"; // E_PROMO_FULL going (also the already-going probe)
const T_FULL_G2 = "15e1b000-0000-4000-8000-000000000021"; // E_PROMO_FULL going
const T_FULL_W = "15e1b000-0000-4000-8000-000000000022"; // E_PROMO_FULL waitlisted — refused (no seat)
const T_UNLIM_W = "15e1b000-0000-4000-8000-000000000030"; // E_PROMO_UNLIM waitlisted — promoted (no cap)
const T_PLUS_G1 = "15e1b000-0000-4000-8000-000000000040"; // E_PROMO_PLUS going
const T_PLUS_W = "15e1b000-0000-4000-8000-000000000041"; // E_PROMO_PLUS waitlisted, plus_ones=2
const T_REJ_W = "15e1b000-0000-4000-8000-000000000050"; // E_PROMO_REJ waitlisted — host-only reject target
const T_BOTH_A = "15e1b000-0000-4000-8000-000000000060"; // E_A_BOTH guest linked to host A's account
const T_ATTEND_A = "15e1b000-0000-4000-8000-000000000061"; // E_B_ATTEND guest linked to host A's account
const T_FORGED = "15e1b000-0000-4000-8000-0000000000ff"; // valid uuid, never inserted

// Every token whose RSVP is seeded (the rsvp insert is scoped to exactly these).
const RSVP_TOKENS = [
  T_VOTE_GOING, T_VOTE_MAYBE, T_VOTE_WAIT, T_VOTE_NOTGO, T_VOTE2, T_VCANCEL, T_FIN,
  T_OK_G1, T_OK_G2, T_OK_W, T_FULL_G1, T_FULL_G2, T_FULL_W, T_UNLIM_W, T_PLUS_G1, T_PLUS_W, T_REJ_W,
];

describe("task 1.5e [SECURITY]: vote/finalize/promote + aggregate reads (TEST-SPEC §1.5e)", () => {
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
  /** Authenticated path — caller's JWT, so auth.uid()/auth.role() reflect the host. */
  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  async function callVote(
    client: SupabaseClient,
    slug: string,
    token?: string,
    optionIds?: string[],
  ): Promise<{ res: ApiResult; data: { event_id?: string; selected_option_ids?: string[] } | null }> {
    const body: Record<string, unknown> = { slug };
    if (token !== undefined) body.guest_token = token;
    if (optionIds !== undefined) body.option_ids = optionIds;
    const res = (await client.rpc(FN_VOTE, body)) as ApiResult;
    return { res, data: (res.data as { event_id?: string; selected_option_ids?: string[] }) ?? null };
  }
  async function callFinalize(
    client: SupabaseClient,
    event_id: string,
    option_id: string,
  ): Promise<{ res: ApiResult; data: Record<string, unknown> | null }> {
    const res = (await client.rpc(FN_FINALIZE, { event_id, option_id })) as ApiResult;
    return { res, data: (res.data as Record<string, unknown>) ?? null };
  }
  async function callPromote(
    client: SupabaseClient,
    rsvp_id: string,
  ): Promise<{ res: ApiResult; data: Record<string, unknown> | null }> {
    const res = (await client.rpc(FN_PROMOTE, { rsvp_id })) as ApiResult;
    return { res, data: (res.data as Record<string, unknown>) ?? null };
  }
  async function callMine(client: SupabaseClient): Promise<{ res: ApiResult; rows: Record<string, unknown>[] }> {
    const res = (await client.rpc(FN_MINE, {})) as ApiResult;
    return { res, rows: (res.data as Record<string, unknown>[]) ?? [] };
  }
  async function callPublic(
    client: SupabaseClient,
    username: string,
  ): Promise<{ res: ApiResult; rows: Record<string, unknown>[] }> {
    const res = (await client.rpc(FN_PUBLIC, { username })) as ApiResult;
    return { res, rows: (res.data as Record<string, unknown>[]) ?? [] };
  }

  /** The sorted set the function says it applied (its confirmation echo). */
  function selectedSet(data: { selected_option_ids?: string[] } | null): string[] {
    return (data?.selected_option_ids ?? []).slice().sort();
  }
  const slugsOf = (rows: Record<string, unknown>[]): string[] => rows.map((r) => String(r.slug));

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();
    expect(hostB?.id, "need >=2 host sessions (host B, the non-owner / cross-user branch)").toBeTruthy();

    // Signatures are pinned (SCHEMA RPC table). The independent test relies on these
    // exact arg names; a rename/reorder is itself a contract break. Crucially neither
    // host-only mutation takes a caller-supplied actor id (the host is auth.uid()), and
    // vote_dates has no guest_id param (the author is helper-resolved).
    expect(inArgNames(FN_VOTE), "vote_dates signature is pinned").toEqual(["slug", "guest_token", "option_ids"]);
    expect(inArgNames(FN_FINALIZE), "finalize_date signature is pinned (no host param)").toEqual(["event_id", "option_id"]);
    expect(inArgNames(FN_PROMOTE), "promote_guest signature is pinned (no host param)").toEqual(["rsvp_id"]);
    expect(inArgNames(FN_MINE), "get_my_events takes no args (caller is auth.uid())").toEqual([]);
    expect(inArgNames(FN_PUBLIC), "get_public_events_by_host signature is pinned").toEqual(["username"]);

    // Idempotent reset (slug/username are UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    runSql(`update public.profiles set username=null where username like '${PREFIX}%';`);

    // Host profiles back guests.user_id + supply usernames for the organizer page.
    // Fill display_name only when null (never clobber a name another suite relies on);
    // set the usernames explicitly (this suite owns them).
    runSql(
      `insert into public.profiles (id, display_name, username) values
         ('${hostA.id}', 't15e host A', '${UNAME_A}'),
         ('${hostB.id}', 't15e host B', '${UNAME_B}')
         on conflict (id) do update
           set display_name = coalesce(public.profiles.display_name, excluded.display_name),
               username      = excluded.username;`,
    );

    // Events. visibility / status / date_tbd / capacity / location vary per scenario.
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, date_tbd, capacity, location_text, location_city) values
         ('${hostA.id}','${E_POLL}',       't15e poll',      'public', 'published', true,  null, null,            null),
         ('${hostA.id}','${E_POLL2}',      't15e poll2',     'public', 'published', true,  null, null,            null),
         ('${hostA.id}','${E_VCANCEL}',    't15e vcancel',   'public', 'cancelled', true,  null, null,            null),
         ('${hostA.id}','${E_FIN}',        't15e fin',       'public', 'published', true,  null, null,            null),
         ('${hostA.id}','${E_FIN_REJ}',    't15e fin rej',   'public', 'published', true,  null, null,            null),
         ('${hostA.id}','${E_PROMO_OK}',   't15e promo ok',  'public', 'published', false, 3,    null,            null),
         ('${hostA.id}','${E_PROMO_FULL}', 't15e promo full','public', 'published', false, 2,    null,            null),
         ('${hostA.id}','${E_PROMO_UNLIM}','t15e promo unl', 'public', 'published', false, null, null,            null),
         ('${hostA.id}','${E_PROMO_PLUS}', 't15e promo plus','public', 'published', false, 4,    null,            null),
         ('${hostA.id}','${E_PROMO_REJ}',  't15e promo rej', 'public', 'published', false, null, null,            null),
         ('${hostA.id}','${E_A_PUBPUB}',   't15e a pubpub',  'public', 'published', false, null, '${SENTINEL_LOC}','${CITY_A}'),
         ('${hostA.id}','${E_A_PRIVATE}',  't15e a private', 'private','published', false, null, '${SENTINEL_LOC}',null),
         ('${hostA.id}','${E_A_DRAFT}',    't15e a draft',   'public', 'draft',     false, null, null,            null),
         ('${hostA.id}','${E_A_CANCEL}',   't15e a cancel',  'public', 'cancelled', false, null, null,            null),
         ('${hostA.id}','${E_A_BOTH}',     't15e a both',    'public', 'published', false, null, null,            null),
         ('${hostB.id}','${E_B_ATTEND}',   't15e b attend',  'public', 'published', false, null, null,            null),
         ('${hostB.id}','${E_B_OTHER}',    't15e b other',   'public', 'published', false, null, null,            null);`,
    );

    // Date options (fixed ids). FO1 carries the timestamps finalize must write back.
    runSql(
      `insert into public.date_options (id, event_id, starts_at, ends_at) values
         ('${O1}',  (select id from public.events where slug='${E_POLL}'),    '2027-01-01 18:00:00+00','2027-01-01 21:00:00+00'),
         ('${O2}',  (select id from public.events where slug='${E_POLL}'),    '2027-02-02 18:00:00+00', null),
         ('${O3}',  (select id from public.events where slug='${E_POLL2}'),   '2027-03-03 18:00:00+00', null),
         ('${FO1}', (select id from public.events where slug='${E_FIN}'),     '2028-09-09 18:00:00+00','2028-09-09 21:00:00+00'),
         ('${FO2}', (select id from public.events where slug='${E_FIN}'),     '2028-10-10 18:00:00+00', null),
         ('${FRO1}',(select id from public.events where slug='${E_FIN_REJ}'), '2029-05-05 18:00:00+00', null),
         ('${VCO}', (select id from public.events where slug='${E_VCANCEL}'), '2027-04-04 18:00:00+00', null);`,
    );

    // Guests. T_BOTH_A / T_ATTEND_A are linked to host A's account (user_id) so the
    // get_my_events host-vs-attend branches resolve; the rest are anonymous token guests.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, user_id) values
         ((select id from public.events where slug='${E_POLL}'),       '${T_VOTE_GOING}'::uuid, 't15e-voter-going', null),
         ((select id from public.events where slug='${E_POLL}'),       '${T_VOTE_MAYBE}'::uuid, 't15e-voter-maybe', null),
         ((select id from public.events where slug='${E_POLL}'),       '${T_VOTE_WAIT}'::uuid,  't15e-voter-wait',  null),
         ((select id from public.events where slug='${E_POLL}'),       '${T_VOTE_NOTGO}'::uuid, 't15e-voter-notgo', null),
         ((select id from public.events where slug='${E_POLL2}'),      '${T_VOTE2}'::uuid,      't15e-poll2-going', null),
         ((select id from public.events where slug='${E_VCANCEL}'),    '${T_VCANCEL}'::uuid,    't15e-vc-going',    null),
         ((select id from public.events where slug='${E_FIN}'),        '${T_FIN}'::uuid,        't15e-fin-going',   null),
         ((select id from public.events where slug='${E_PROMO_OK}'),   '${T_OK_G1}'::uuid,      't15e-ok-g1',       null),
         ((select id from public.events where slug='${E_PROMO_OK}'),   '${T_OK_G2}'::uuid,      't15e-ok-g2',       null),
         ((select id from public.events where slug='${E_PROMO_OK}'),   '${T_OK_W}'::uuid,       't15e-ok-w',        null),
         ((select id from public.events where slug='${E_PROMO_FULL}'), '${T_FULL_G1}'::uuid,    't15e-full-g1',     null),
         ((select id from public.events where slug='${E_PROMO_FULL}'), '${T_FULL_G2}'::uuid,    't15e-full-g2',     null),
         ((select id from public.events where slug='${E_PROMO_FULL}'), '${T_FULL_W}'::uuid,     't15e-full-w',      null),
         ((select id from public.events where slug='${E_PROMO_UNLIM}'),'${T_UNLIM_W}'::uuid,    't15e-unl-w',       null),
         ((select id from public.events where slug='${E_PROMO_PLUS}'), '${T_PLUS_G1}'::uuid,    't15e-plus-g1',     null),
         ((select id from public.events where slug='${E_PROMO_PLUS}'), '${T_PLUS_W}'::uuid,     't15e-plus-w',      null),
         ((select id from public.events where slug='${E_PROMO_REJ}'),  '${T_REJ_W}'::uuid,      't15e-rej-w',       null),
         ((select id from public.events where slug='${E_A_BOTH}'),     '${T_BOTH_A}'::uuid,     't15e-both-a',      '${hostA.id}'),
         ((select id from public.events where slug='${E_B_ATTEND}'),   '${T_ATTEND_A}'::uuid,   't15e-attend-a',    '${hostA.id}');`,
    );

    // RSVPs — status keyed by each guest's deterministic token; plus_ones only on T_PLUS_W.
    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_VOTE_GOING}'::uuid then 'going'
             when '${T_VOTE_MAYBE}'::uuid then 'maybe'
             when '${T_VOTE_WAIT}'::uuid  then 'waitlisted'
             when '${T_VOTE_NOTGO}'::uuid then 'not_going'
             when '${T_VOTE2}'::uuid      then 'going'
             when '${T_VCANCEL}'::uuid    then 'going'
             when '${T_FIN}'::uuid        then 'going'
             when '${T_OK_G1}'::uuid      then 'going'
             when '${T_OK_G2}'::uuid      then 'going'
             when '${T_OK_W}'::uuid       then 'waitlisted'
             when '${T_FULL_G1}'::uuid    then 'going'
             when '${T_FULL_G2}'::uuid    then 'going'
             when '${T_FULL_W}'::uuid     then 'waitlisted'
             when '${T_UNLIM_W}'::uuid    then 'waitlisted'
             when '${T_PLUS_G1}'::uuid    then 'going'
             when '${T_PLUS_W}'::uuid     then 'waitlisted'
             when '${T_REJ_W}'::uuid      then 'waitlisted'
           end,
           case g.guest_token when '${T_PLUS_W}'::uuid then 2 else 0 end
         from public.guests g
         where g.guest_token in (${RSVP_TOKENS.map((t) => `'${t}'::uuid`).join(",")});`,
    );

    // Pre-seed two votes DIRECTLY (not via the RPC): FO1←T_FIN (must survive finalize)
    // and O3←T_VOTE2 (the foreign-option isolation control — must stay untouched).
    runSql(
      `insert into public.date_votes (date_option_id, guest_id)
         select '${FO1}'::uuid, g.id from public.guests g where g.guest_token='${T_FIN}'::uuid
         union all
         select '${O3}'::uuid,  g.id from public.guests g where g.guest_token='${T_VOTE2}'::uuid;`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    // ON DELETE CASCADE clears seeded guests/rsvps/options/votes with the event.
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    // Free the unique usernames so a re-run (or a later suite) isn't blocked.
    runSql(`update public.profiles set username=null where username like '${PREFIX}%';`);
  });

  // ───────────────────────────── vote_dates ─────────────────────────────

  // §1.5e — multi-select UPSERT that REPLACES the selection (去掉未选项). One guest,
  // one sequential story: add O1 → add O2 → drop to just O2 → clear entirely.
  it.skipIf(!LOCAL_UP)(
    "vote_dates is a replacing multi-select upsert: [O1] → [O1,O2] → [O2] (O1 removed) → [] (all cleared); each step the DB matches the confirmation",
    async () => {
      const an = anon();
      const evId = eventId(E_POLL);

      // [O1]
      const a = await callVote(an, E_POLL, T_VOTE_GOING, [O1]);
      expect(a.res.error, JSON.stringify(a.res.error)).toBeNull();
      expect(a.data?.event_id, "confirmation carries the event id").toBe(evId);
      expect(selectedSet(a.data), "confirmation echoes [O1]").toEqual([O1]);
      expect(guestVoteOptionIds(T_VOTE_GOING), "DB holds exactly [O1]").toEqual([O1]);

      // [O1,O2] — add a second option.
      const b = await callVote(an, E_POLL, T_VOTE_GOING, [O1, O2]);
      expect(b.res.error, JSON.stringify(b.res.error)).toBeNull();
      expect(selectedSet(b.data), "confirmation echoes [O1,O2]").toEqual([O1, O2].sort());
      expect(guestVoteOptionIds(T_VOTE_GOING), "DB holds exactly [O1,O2]").toEqual([O1, O2].sort());

      // [O2] — re-voting a SMALLER set must DROP the de-selected O1 (去掉未选项).
      const c = await callVote(an, E_POLL, T_VOTE_GOING, [O2]);
      expect(c.res.error, JSON.stringify(c.res.error)).toBeNull();
      expect(selectedSet(c.data), "confirmation echoes [O2] only").toEqual([O2]);
      expect(guestVoteOptionIds(T_VOTE_GOING), "O1 was removed — DB holds exactly [O2]").toEqual([O2]);

      // [] — an empty selection clears every vote of this guest.
      const d = await callVote(an, E_POLL, T_VOTE_GOING, []);
      expect(d.res.error, JSON.stringify(d.res.error)).toBeNull();
      expect(selectedSet(d.data), "confirmation echoes []").toEqual([]);
      expect(guestVoteOptionIds(T_VOTE_GOING), "empty selection clears all of this guest's votes").toEqual([]);
    },
  );

  // §1.5e — the rest of the unlock set may vote; the locked set cannot, and a rejected
  // vote inserts nothing.
  it.skipIf(!LOCAL_UP)(
    "maybe and waitlisted tokens unlock voting; no token / forged / not_going / cross-event token are all rejected and insert nothing",
    async () => {
      const an = anon();

      // maybe & waitlisted are in the unlock set {going,maybe,waitlisted}.
      const maybe = await callVote(an, E_POLL, T_VOTE_MAYBE, [O1]);
      expect(maybe.res.error, "maybe unlocks voting").toBeNull();
      expect(guestVoteOptionIds(T_VOTE_MAYBE), "maybe guest's vote recorded").toEqual([O1]);

      const wait = await callVote(an, E_POLL, T_VOTE_WAIT, [O2]);
      expect(wait.res.error, "waitlisted unlocks voting").toBeNull();
      expect(guestVoteOptionIds(T_VOTE_WAIT), "waitlisted guest's vote recorded").toEqual([O2]);

      // not_going is NOT in the unlock set ⇒ rejected (RSVP-required), nothing written.
      const notgo = await callVote(an, E_POLL, T_VOTE_NOTGO, [O1]);
      expect(notgo.res.error, "not_going does NOT unlock ⇒ rejected").not.toBeNull();
      expect(notgo.res.error?.message, "refusal tells the guest to RSVP").toMatch(/RSVP/i);
      expect(guestVoteOptionIds(T_VOTE_NOTGO), "a rejected vote inserts nothing (not_going)").toEqual([]);

      // No token at all ⇒ rejected.
      const noTok = await callVote(an, E_POLL, undefined, [O1]);
      expect(noTok.res.error, "no token ⇒ rejected").not.toBeNull();

      // Forged token (valid uuid, matches no guest) ⇒ rejected.
      const forged = await callVote(an, E_POLL, T_FORGED, [O1]);
      expect(forged.res.error, "forged token ⇒ rejected").not.toBeNull();

      // Cross-event token: T_VOTE2 belongs to E_POLL2; presented to E_POLL it unlocks
      // nothing here ⇒ rejected. (Its own E_POLL2 vote is checked untouched below.)
      const cross = await callVote(an, E_POLL, T_VOTE2, [O1]);
      expect(cross.res.error, "event B's token replayed on event A ⇒ rejected (event-scoped gate)").not.toBeNull();
    },
  );

  // §1.5e 更狠 — a forged / foreign option_id is silently dropped and can NEVER reach
  // another event's votes (the delete is scoped through this event's options).
  it.skipIf(!LOCAL_UP)(
    "a foreign option_id (belonging to another event) is dropped, never inserted, and the other event's votes are left completely untouched",
    async () => {
      const an = anon();
      const poll2Before = eventVoteCount(E_POLL2); // O3 has exactly one vote (T_VOTE2)
      expect(poll2Before, "control: E_POLL2 starts with its one seeded vote").toBe(1);

      // Vote on E_POLL passing O1 (valid here) + O3 (FOREIGN — belongs to E_POLL2).
      const r = await callVote(an, E_POLL, T_VOTE_GOING, [O1, O3]);
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();

      // O3 is dropped: the confirmation and the DB both hold only O1.
      expect(selectedSet(r.data), "foreign O3 is dropped from the applied selection").toEqual([O1]);
      expect(guestVoteOptionIds(T_VOTE_GOING), "voter has NO vote on the foreign option").toEqual([O1]);

      // The foreign event's poll is completely unaffected — neither inserted into nor
      // deleted from (the scoped delete can't reach it).
      expect(eventVoteCount(E_POLL2), "E_POLL2's votes are untouched by a vote on E_POLL").toBe(poll2Before);
      expect(guestVoteOptionIds(T_VOTE2), "E_POLL2's own voter still holds its O3 vote").toEqual([O3]);
    },
  );

  // §1.5e 更狠 — a cancelled event refuses votes outright (no poll to write to).
  it.skipIf(!LOCAL_UP)(
    "vote_dates on a CANCELLED event is rejected even for a going guest, and nothing is written",
    async () => {
      const r = await callVote(anon(), E_VCANCEL, T_VCANCEL, [VCO]);
      expect(r.res.error, "a cancelled event accepts no vote").not.toBeNull();
      expect(r.res.error?.message, "the refusal names the cancellation").toMatch(/cancel/i);
      expect(guestVoteOptionIds(T_VCANCEL), "no vote written on a cancelled event").toEqual([]);
    },
  );

  // §1.5e (G1) — date_votes is reachable ONLY through the RPC: anon has no direct grant.
  it.skipIf(!LOCAL_UP)(
    "anon cannot SELECT or INSERT date_votes directly — vote_dates is the only write path (G1)",
    async () => {
      const an = anon();
      const sel = await an.from("date_votes").select("*");
      expect((sel.data ?? []).length, "anon direct SELECT on date_votes leaks no rows").toBe(0);

      const ins = await an.from("date_votes").insert({ date_option_id: O1, guest_id: guestIdOf(T_VOTE_GOING) });
      expect(ins.error, "anon direct INSERT into date_votes is denied (no grant/policy)").not.toBeNull();
    },
  );

  // ───────────────────────────── finalize_date ─────────────────────────────

  // §1.5e (D7③) — HOST-ONLY: a non-host, a service-role (no auth context), and anon are
  // ALL rejected; a cross-event option is rejected. E_FIN_REJ is never mutated, so we
  // assert its date stays TBD throughout.
  it.skipIf(!LOCAL_UP)(
    "finalize_date is host-only: service-role (no auth.uid), a non-owner host, and anon are all rejected; a cross-event option is rejected; the event stays unfinalized",
    async () => {
      const evId = eventId(E_FIN_REJ);
      // FRO1 is a VALID option on E_FIN_REJ, so each call reaches the function body and
      // is judged by the auth gate — not bounced at uuid arg-parsing before the gate runs.

      // service-role: auth.uid() is NULL ⇒ the explicit null guard fires (42501). This
      // is the D7③ keystone — without it, host_id<>NULL is NULL (not raised) and a cron
      // could finalize. Probed live: code 42501, message "authentication required".
      const svc = await callFinalize(service(), evId, FRO1);
      expect(svc.res.error, "service-role finalize ⇒ rejected (no auth context, D7③)").not.toBeNull();
      expect(svc.res.error?.code, "rejection is insufficient_privilege (42501)").toBe("42501");
      expect(svc.res.error?.message, "rejected for missing auth, not host mismatch").toMatch(/auth/i);

      // A different authenticated host is not the owner ⇒ 42501 "only the host …".
      const other = await callFinalize(asHost(hostB.accessToken), evId, FRO1);
      expect(other.res.error, "a non-owner host finalize ⇒ rejected").not.toBeNull();
      expect(other.res.error?.code, "rejection is insufficient_privilege (42501)").toBe("42501");
      expect(other.res.error?.message, "rejected as not-the-host").toMatch(/host/i);

      // anon has no execute grant ⇒ rejected (still 42501 at the privilege layer).
      const an = await callFinalize(anon(), evId, FRO1);
      expect(an.res.error, "anon finalize ⇒ rejected (no execute grant)").not.toBeNull();

      // The OWNER passing an option that belongs to ANOTHER event ⇒ rejected (no
      // cross-event finalize). Auth passes (A owns E_FIN_REJ); the option lookup fails.
      const crossOpt = await callFinalize(asHost(hostA.accessToken), evId, O1); // O1 ∈ E_POLL
      expect(crossOpt.res.error, "an option from another event ⇒ rejected").not.toBeNull();
      expect(crossOpt.res.error?.message, "refusal names the option/event mismatch").toMatch(/option|not found/i);

      // Nothing above mutated the event: it is still TBD with no start.
      expect(eventStartsAt(E_FIN_REJ), "no rejected finalize wrote starts_at").toBe("<null>");
      expect(eventDateTbd(E_FIN_REJ), "the event is still date_tbd=true").toBe("t");
    },
  );

  // §1.5e — the owning host finalizes: starts_at/ends_at written, date_tbd cleared, and
  // the existing votes SURVIVE (保留投票记录, D7③).
  it.skipIf(!LOCAL_UP)(
    "the owning host finalizes the date: events.starts_at/ends_at are written from the option, date_tbd becomes false, and the poll's votes are KEPT",
    async () => {
      const evId = eventId(E_FIN);
      const votesBefore = eventVoteCount(E_FIN);
      expect(votesBefore, "control: E_FIN has its one seeded vote before finalize").toBe(1);
      expect(eventStartsAt(E_FIN), "control: E_FIN has no start before finalize").toBe("<null>");

      const r = await callFinalize(asHost(hostA.accessToken), evId, FO1);
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expect(r.data?.date_tbd, "confirmation reports date_tbd=false").toBe(false);
      expect(r.data?.option_id, "confirmation reports the chosen option").toBe(FO1);

      // The event now carries FO1's timestamps and is no longer TBD.
      expect(eventStartsAt(E_FIN), "starts_at written from the chosen option (FO1)").toContain("2028-09-09 18:00:00");
      expect(eventDateTbd(E_FIN), "date_tbd cleared").toBe("f");

      // The poll is KEPT: finalize never deletes options/votes.
      expect(eventVoteCount(E_FIN), "votes survive finalize (保留投票记录)").toBe(votesBefore);
      expect(guestVoteOptionIds(T_FIN), "the finalized event still holds the guest's vote").toEqual([FO1]);
    },
  );

  // ───────────────────────────── promote_guest ─────────────────────────────

  // §1.5e (D7③) — HOST-ONLY: service-role, a non-owner host, and anon are all rejected,
  // and the waitlisted guest stays waitlisted (E_PROMO_REJ is never successfully mutated).
  it.skipIf(!LOCAL_UP)(
    "promote_guest is host-only: service-role (no auth.uid), a non-owner host, and anon are all rejected; the guest stays waitlisted",
    async () => {
      const rsvpId = rsvpIdByToken(T_REJ_W);

      const svc = await callPromote(service(), rsvpId);
      expect(svc.res.error, "service-role promote ⇒ rejected (no auth context, D7③)").not.toBeNull();
      expect(svc.res.error?.code, "rejection is insufficient_privilege (42501)").toBe("42501");
      expect(svc.res.error?.message, "rejected for missing auth").toMatch(/auth/i);

      const other = await callPromote(asHost(hostB.accessToken), rsvpId);
      expect(other.res.error, "a non-owner host promote ⇒ rejected").not.toBeNull();
      expect(other.res.error?.code, "rejection is insufficient_privilege (42501)").toBe("42501");
      expect(other.res.error?.message, "rejected as not-the-host").toMatch(/host/i);

      const an = await callPromote(anon(), rsvpId);
      expect(an.res.error, "anon promote ⇒ rejected (no execute grant)").not.toBeNull();

      expect(rsvpStatusByToken(T_REJ_W), "no rejected promote changed the status").toBe("waitlisted");
    },
  );

  // §1.5e — the owning host promotes within capacity: waitlist → going.
  it.skipIf(!LOCAL_UP)(
    "the owning host promotes a waitlisted guest that fits capacity: status becomes 'going'",
    async () => {
      // E_PROMO_OK: capacity 3, two going (occupancy 2) + one waitlisted (needs 1) ⇒ fits.
      expect(rsvpStatusByToken(T_OK_W), "control: starts waitlisted").toBe("waitlisted");
      const r = await callPromote(asHost(hostA.accessToken), rsvpIdByToken(T_OK_W));
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expect(r.data?.status, "confirmation reports 'going'").toBe("going");
      expect(rsvpStatusByToken(T_OK_W), "the guest is now going").toBe("going");
    },
  );

  // §1.5e — capacity is RESPECTED (尊重容量): a promote that would oversell is refused,
  // and an already-going guest cannot be promoted again.
  it.skipIf(!LOCAL_UP)(
    "promote_guest respects capacity: promoting into a full event is refused (guest stays waitlisted); an already-going RSVP cannot be promoted",
    async () => {
      // E_PROMO_FULL: capacity 2, two going (occupancy 2) ⇒ no seat for the waitlisted one.
      const full = await callPromote(asHost(hostA.accessToken), rsvpIdByToken(T_FULL_W));
      expect(full.res.error, "promoting past capacity ⇒ refused").not.toBeNull();
      expect(full.res.error?.message, "refusal names capacity").toMatch(/capacit/i);
      expect(rsvpStatusByToken(T_FULL_W), "the refused guest stays waitlisted").toBe("waitlisted");

      // A non-waitlisted (already going) RSVP is not promotable.
      const going = await callPromote(asHost(hostA.accessToken), rsvpIdByToken(T_FULL_G1));
      expect(going.res.error, "only a waitlisted guest can be promoted").not.toBeNull();
      expect(going.res.error?.message, "refusal names the waitlist requirement").toMatch(/waitlist/i);
      expect(rsvpStatusByToken(T_FULL_G1), "the going guest is untouched").toBe("going");
    },
  );

  // §1.5e — NULL capacity is unlimited; plus_ones count toward the seat math.
  it.skipIf(!LOCAL_UP)(
    "a NULL-capacity event always has room (promote succeeds); plus_ones are counted in the capacity check on promote",
    async () => {
      // Unlimited: capacity NULL ⇒ promote always fits.
      const unl = await callPromote(asHost(hostA.accessToken), rsvpIdByToken(T_UNLIM_W));
      expect(unl.res.error, "NULL capacity ⇒ always room").toBeNull();
      expect(rsvpStatusByToken(T_UNLIM_W), "unlimited event promotes the guest").toBe("going");

      // E_PROMO_PLUS: capacity 4, one going (occupancy 1); the waitlisted guest brings
      // plus_ones=2 (needs 3 seats) ⇒ 1+3=4 exactly fits, proving plus_ones are counted.
      const plus = await callPromote(asHost(hostA.accessToken), rsvpIdByToken(T_PLUS_W));
      expect(plus.res.error, "a +2 guest fits the last 3 seats of a cap-4 event").toBeNull();
      expect(rsvpStatusByToken(T_PLUS_W), "the +2 guest is promoted to going").toBe("going");

      // The event is now exactly full (1 + 3 = 4): a hypothetical further promote here
      // would have no seat — the boundary held at, not past, capacity.
      const occ = Number(
        scalar(
          runSql(
            `select coalesce(sum(1 + r.plus_ones),0) from public.rsvps r
               join public.events e on e.id=r.event_id
              where e.slug='${E_PROMO_PLUS}' and r.status='going';`,
          ),
        ),
      );
      expect(occ, "occupancy counts the promoted guest's plus_ones (now exactly capacity 4)").toBe(4);
    },
  );

  // ───────────────────────────── get_my_events ─────────────────────────────

  // §1.5e (D1) — the unified feed: events I host ∪ events I attend, each once,
  // role-discriminated, NEVER another user's, and desensitized (no full address).
  it.skipIf(!LOCAL_UP)(
    "get_my_events returns my hosted + my attended events (role-discriminated), once each, and never another user's; the full location_text never rides along",
    async () => {
      const mine = await callMine(asHost(hostA.accessToken));
      expect(mine.res.error, JSON.stringify(mine.res.error)).toBeNull();
      const slugs = slugsOf(mine.rows);

      // Hosted: E_A_PUBPUB (host_id = A) is present as role='host'.
      expect(slugs, "an event I host appears").toContain(E_A_PUBPUB);
      // Attended: E_B_ATTEND is host B's, but A is linked via guests.user_id ⇒ role='guest'.
      expect(slugs, "an event I attend (via guests.user_id) appears").toContain(E_B_ATTEND);
      // NOT mine: E_B_OTHER is host B's and A neither hosts nor attends ⇒ absent (不串他人).
      expect(slugs, "another host's event I don't attend must NOT appear").not.toContain(E_B_OTHER);

      const bySlug = new Map(mine.rows.map((r) => [String(r.slug), r]));
      expect(bySlug.get(E_A_PUBPUB)?.role, "a hosted event is role=host").toBe("host");
      expect(bySlug.get(E_B_ATTEND)?.role, "an attended event is role=guest").toBe("guest");

      // host_id is the authority: an event where I am BOTH host and a guest appears ONCE,
      // as role=host (not duplicated, not downgraded to guest).
      const bothRows = mine.rows.filter((r) => String(r.slug) === E_A_BOTH);
      expect(bothRows.length, "host+guest event appears exactly once").toBe(1);
      expect(bothRows[0]?.role, "host+guest event is role=host (host_id authority)").toBe("host");

      // Desensitized list view: city may show, the full street address never does.
      const json = JSON.stringify(mine.rows);
      expect(json, "the second-tier location_text must NEVER appear in the list feed").not.toContain(SENTINEL_LOC);
      expect(json, "the first-tier location_city is fine to show").toContain(CITY_A);
    },
  );

  // §1.5e (D1) — cross-user isolation in the other direction, and the no-auth floor.
  it.skipIf(!LOCAL_UP)(
    "get_my_events is per-caller: host B does NOT see host A's events; anon retrieves nothing, and a no-user (service_role) context yields an empty list",
    async () => {
      const bMine = await callMine(asHost(hostB.accessToken));
      expect(bMine.res.error, JSON.stringify(bMine.res.error)).toBeNull();
      const bSlugs = slugsOf(bMine.rows);
      expect(bSlugs, "B owns + B attends E_B_ATTEND").toContain(E_B_ATTEND);
      expect(bSlugs, "B must NOT see A's hosted event").not.toContain(E_A_PUBPUB);
      expect(bSlugs, "B must NOT see A's host+guest event").not.toContain(E_A_BOTH);

      // anon is not even granted execute (only authenticated/service_role are). Whether
      // that surfaces as permission-denied or an empty list, the security property is the
      // same: an unauthenticated caller retrieves NONE of anyone's events. `rows` is []
      // both when denied (data=null) and when the function returns []. We assert that.
      const anonMine = await callMine(anon());
      expect(anonMine.rows.length, "anon retrieves no events via get_my_events (denied or empty — never leaks)").toBe(0);

      // The SSR path (service_role) IS granted but carries no user `sub`, so auth.uid()
      // is null and the explicit null-guard branch returns an empty list (no error, no
      // rows) — it must NOT fall through and dump every event.
      const ssrMine = await callMine(service());
      expect(ssrMine.res.error, "service_role get_my_events does not error").toBeNull();
      expect(ssrMine.rows.length, "no user context ⇒ empty list (null-guard branch), not every event").toBe(0);
    },
  );

  // ──────────────────────── get_public_events_by_host ────────────────────────

  // §1.5e (D2) — the organizer page: ONLY public+published, never private/draft/
  // cancelled, never another host's, no full address; served to anon without a table grant.
  it.skipIf(!LOCAL_UP)(
    "get_public_events_by_host returns only the host's public+published events — private, draft, and cancelled are all excluded, and so are other hosts' events",
    async () => {
      const pub = await callPublic(anon(), UNAME_A);
      expect(pub.res.error, JSON.stringify(pub.res.error)).toBeNull();
      const slugs = slugsOf(pub.rows);

      expect(slugs, "A's public+published event is listed").toContain(E_A_PUBPUB);
      expect(slugs, "a PRIVATE event is never listed").not.toContain(E_A_PRIVATE);
      expect(slugs, "a DRAFT event is never listed").not.toContain(E_A_DRAFT);
      expect(slugs, "a CANCELLED event is never listed").not.toContain(E_A_CANCEL);
      expect(slugs, "another host's event is never listed under A").not.toContain(E_B_OTHER);

      // Every returned row really is public+published (cross-checked against the DB).
      for (const s of slugs) {
        const vis = scalar(runSql(`select visibility||'/'||status from public.events where slug='${s}';`));
        expect(vis, `listed event ${s} is public/published`).toBe("public/published");
      }

      // Desensitized: the full address never leaks; the city is the first-tier field.
      const json = JSON.stringify(pub.rows);
      expect(json, "the organizer page must not leak the full location_text").not.toContain(SENTINEL_LOC);
      expect(json, "location_city is a first-tier field and may show").toContain(CITY_A);
    },
  );

  // §1.5e (D2) 更狠 — an unknown username is no oracle; the per-host scope holds both ways.
  it.skipIf(!LOCAL_UP)(
    "get_public_events_by_host scopes to the named host: an unknown username yields [], and host B's list contains B's event but not A's",
    async () => {
      const unknown = await callPublic(anon(), "t15e-no-such-username-xyz");
      expect(unknown.res.error, "unknown username does not error").toBeNull();
      expect(unknown.rows.length, "unknown username ⇒ empty list (no existence oracle)").toBe(0);

      const bPub = await callPublic(anon(), UNAME_B);
      expect(bPub.res.error, JSON.stringify(bPub.res.error)).toBeNull();
      const bSlugs = slugsOf(bPub.rows);
      expect(bSlugs, "B's public+published event is listed under B").toContain(E_B_OTHER);
      expect(bSlugs, "A's events never appear under B").not.toContain(E_A_PUBPUB);
    },
  );
});
