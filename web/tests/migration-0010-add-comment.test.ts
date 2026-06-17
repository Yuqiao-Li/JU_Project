import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.5d [SECURITY] — `get_comments` (read-open, visibility-gated) and
 * `add_comment` (write-gated, author bound server-side), the two Activity-Feed
 * comment RPCs (migration 0010_add_comment.sql, logical "0005e";
 * TEST-SPEC §1.5d + §4.1).
 *
 * Written by the INDEPENDENT test agent (never wrote the implementation) with the
 * stance "assume this RPC lets a stranger post, lets the client choose the author,
 * leaks a private event's feed, writes a GIF, or exposes a guest_id/contact/token".
 * `anon` has NO direct privilege on comments (0004/0005), so EVERY guest read and
 * write of the feed flows through these two SECURITY DEFINER functions — a single
 * missing branch lets an un-RSVP'd stranger post, lets a client forge authorship,
 * or leaks a private event's comments. The pinned contract (SCHEMA 安全模型 §1/§2
 * 单一读/写路径 + "get_comments"/"add_comment" rows; D3/D5/D6/D14; G1/G4) is hammered
 * from every angle:
 *
 *   1. READ IS OPEN (D6 读开放). An un-RSVP'd / no-token caller CAN read the feed —
 *      get_comments has NO unlock gate. But it KEEPS the D3 visibility gate: a
 *      private event's feed is reachable ONLY via the trusted SSR path
 *      (service_role); anon / an authenticated guest hitting a private slug
 *      directly — even the OWNER host, and even WITH a valid unlock token — get []
 *      (private comments never leak).
 *   2. WRITE GATE = the shared helper ONLY (G4). To post, a guest must be UNLOCKED
 *      (going/maybe/waitlisted). No token / forged token / cross-event token / a
 *      not_going RSVP ⇒ rejected, and the refusal tells them to RSVP first (§4.1).
 *   3. AUTHOR BOUND SERVER-SIDE (D6). There is NO guest_id/host_id parameter, so a
 *      forged-author attempt cannot even be invoked (PostgREST PGRST202). The author
 *      is the host (auth.uid()=host_id) or the guest_id the shared helper RESOLVES
 *      from the verified token/account — never anything the client sent.
 *   4. rsvp_enabled=false ⇒ HOST-ONLY (D6). Even a fully-unlocked guest is rejected;
 *      only the event host may post.
 *   5. DESENSITIZED (第三类 never leaks). Each entry (read AND write confirmation)
 *      exposes ONLY id / body / author_display_name / is_host / created_at — the
 *      author's guest_id / host_id / user_id / contact / token are structurally
 *      absent. gif_url is NEVER written (D6 — XSS面 removed).
 *   6. WRITE-SIDE DEPTH RATE LIMIT (D14/G7). An anon caller hammering add_comment
 *      directly (bypassing the Next/Upstash read limiter) is still stopped by the DB
 *      `rate_limits` backstop — "绕 Next 也拦" (§2.3.5).
 *   7. NO ORACLE / SINGLE READ PATH (G1). Unknown slug and private-blocked both
 *      return the SAME '[]'; anon still cannot SELECT/INSERT comments directly — the
 *      RPCs are the only way the feed is ever reachable.
 *
 * Calls go over PostgREST (.rpc) on the real role paths — anon presents a token, an
 * authenticated session exercises the host / account(user_id) branches, service is
 * the trusted SSR path that may read a private feed — because auth.uid()/auth.role()
 * only reflect the caller's JWT over that wire. Seeding is done as the postgres
 * superuser (psql): with Supabase auto-expose OFF, anon/service have no API grant on
 * events/guests/rsvps/comments so PostgREST can't INSERT them; only the SECURITY
 * DEFINER RPC can. Same pattern as the 1.1–1.5c suites. Gated on a reachable local
 * stack so the file skips (green) without Docker; where the stack IS up, the gate
 * must really hold.
 */
const LOCAL_UP = localStackRunning();

const FN_ADD = "add_comment";
const FN_GET = "get_comments";

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

/** The guest_id behind a deterministic token (for forgery-target / leak probes). */
function guestIdOf(token: string): string {
  return scalar(runSql(`select id from public.guests where guest_token='${token}'::uuid;`));
}

/** gif_url of a comment row (D6: add_comment must NEVER write it). */
function gifUrlOf(commentId: string): string {
  return scalar(runSql(`select coalesce(gif_url, '<null>') from public.comments where id='${commentId}';`));
}

/** Number of comment rows on an event (the write gate must not insert when it rejects). */
function commentCount(slug: string): number {
  return Number(
    scalar(
      runSql(
        `select count(*) from public.comments c
           join public.events e on e.id=c.event_id where e.slug='${slug}';`,
      ),
    ),
  );
}

// A PostgREST response, structurally — { data, error } is all we read.
type ApiResult = { data: unknown; error: { message?: string; code?: string } | null };
/** A desensitized feed/confirmation entry — the ONLY keys that may ever appear (D6). */
interface CommentEntry {
  id: string;
  body: string;
  author_display_name: string | null;
  is_host: boolean;
  created_at: string;
}
/** The exact, complete key set of one entry. Anything more is a third-tier leak. */
const ALLOWED_KEYS = ["author_display_name", "body", "created_at", "id", "is_host"]; // sorted

// ── Sentinels — unique enough to prove a specific value never crosses a boundary.
const PREFIX = "t15d"; // cleanup deletes every event whose title/slug starts here
const SENTINEL_CONTACT = "t15d-contact-secret@sentinel.invalid"; // host-only; must NEVER appear

// Pre-seeded feed bodies (the read-open / ordering / private-leak fixtures).
const B_GUEST1 = "t15d-seed-guest-comment-1";
const B_HOST = "t15d-seed-host-comment";
const B_GUEST2 = "t15d-seed-guest-comment-2";
const B_PRIVATE = "t15d-seed-private-comment";

// Per-scenario events (separate so each scenario's feed/counters are isolated).
const E_PUBLIC = "t15d-public"; // public+published — read-open feed + main write target
const E_PRIVATE = "t15d-private"; // private — D3 read gate (only SSR sees the feed)
const E_RSVPOFF = "t15d-rsvpoff"; // rsvp_enabled=false — host-only commenting (D6)
const E_CROSS_A = "t15d-cross-a"; // a token lives here…
const E_CROSS_B = "t15d-cross-b"; // …and is replayed against here (event-scoped gate)
const E_ACCOUNT = "t15d-account"; // account/user_id unlock branch (no token, cross-device)
const E_CANCELLED = "t15d-cancelled"; // status=cancelled — add_comment refused
const E_RL = "t15d-ratelimit"; // write-side DB rate limit (D14)

// Fixed guest_token uuids so forged / cross-event / pre-seeded probes are deterministic.
const T_GOING = "15d00000-0000-4000-8000-000000000001"; // E_PUBLIC: going +2, carries the sentinel contact
const T_MAYBE = "15d00000-0000-4000-8000-000000000002"; // E_PUBLIC: maybe (unlocks)
const T_WAIT = "15d00000-0000-4000-8000-000000000003"; // E_PUBLIC: waitlisted (unlocks)
const T_NOTGOING = "15d00000-0000-4000-8000-000000000004"; // E_PUBLIC: not_going (does NOT unlock)
const T_OTHER = "15d00000-0000-4000-8000-000000000005"; // E_PUBLIC: going — the impersonation TARGET
const T_PRIV = "15d00000-0000-4000-8000-000000000006"; // E_PRIVATE: going (still can't read via anon, D3)
const T_RSVPOFF = "15d00000-0000-4000-8000-000000000007"; // E_RSVPOFF: going — yet still host-only
const T_CROSS = "15d00000-0000-4000-8000-000000000008"; // E_CROSS_A: going (replayed on E_CROSS_B)
const T_CROSSB = "15d00000-0000-4000-8000-000000000009"; // E_CROSS_B: going (B's own valid unlock)
const T_RL = "15d00000-0000-4000-8000-00000000000a"; // E_RL: going — shared rate-limit bucket
const T_ACCT = "15d00000-0000-4000-8000-00000000000b"; // E_ACCOUNT: going, linked to host B's account
const T_FORGED = "15d00000-0000-4000-8000-0000000000ff"; // valid uuid, never inserted

// Every seeded token — none may ever appear in any returned feed body (第三类).
const ALL_TOKENS = [
  T_GOING, T_MAYBE, T_WAIT, T_NOTGOING, T_OTHER, T_PRIV, T_RSVPOFF, T_CROSS, T_CROSSB, T_RL, T_ACCT,
];

describe("task 1.5d [SECURITY]: add_comment / get_comments (TEST-SPEC §1.5d + §4.1)", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];
  /** Host A's effective profile display_name — the author name of a host comment. */
  let hostAName = "";

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

  /** Call get_comments over PostgREST; omit token to leave it at its SQL default. */
  async function callGet(
    client: SupabaseClient,
    slug: string,
    token?: string,
  ): Promise<{ res: ApiResult; data: CommentEntry[] | null }> {
    const body: Record<string, unknown> = { slug };
    if (token !== undefined) body.guest_token = token;
    const res = (await client.rpc(FN_GET, body)) as ApiResult;
    return { res, data: (res.data as CommentEntry[]) ?? null };
  }

  /** Call add_comment over PostgREST; `extra` injects forged params for the §作者伪造 probe. */
  async function callAdd(
    client: SupabaseClient,
    args: {
      slug: string;
      guest_token?: string;
      body?: string;
      client_fingerprint?: string;
      extra?: Record<string, unknown>;
    },
  ): Promise<{ res: ApiResult; data: CommentEntry | null }> {
    const body: Record<string, unknown> = { slug: args.slug };
    if (args.guest_token !== undefined) body.guest_token = args.guest_token;
    if (args.body !== undefined) body.body = args.body;
    if (args.client_fingerprint !== undefined) body.client_fingerprint = args.client_fingerprint;
    if (args.extra) Object.assign(body, args.extra);
    const res = (await client.rpc(FN_ADD, body)) as ApiResult;
    return { res, data: (res.data as CommentEntry) ?? null };
  }

  /** Assert a successful, structurally-empty feed (the no-oracle / private-blocked outcome). */
  function expectEmptyFeed(r: { res: ApiResult; data: CommentEntry[] | null }, label: string): void {
    expect(r.res.error, `${label}: ${JSON.stringify(r.res.error)}`).toBeNull();
    expect(Array.isArray(r.data), `${label}: result is a jsonb array`).toBe(true);
    expect(r.data?.length, `${label}: empty feed (空) — no comment revealed`).toBe(0);
  }

  /** Assert every entry is fully desensitized: exactly the 5 allowed keys, and no
   *  third-tier value (contact / any seeded token) ever rides along. */
  function expectDesensitized(entries: CommentEntry[], label: string): void {
    const json = JSON.stringify(entries);
    expect(json, `${label}: host-only contact must never ride along`).not.toContain(SENTINEL_CONTACT);
    for (const tok of ALL_TOKENS) {
      expect(json, `${label}: guest_token ${tok} must never appear`).not.toContain(tok);
    }
    for (const e of entries) {
      expect(Object.keys(e).sort(), `${label}: entry exposes ONLY id/body/author_display_name/is_host/created_at`)
        .toEqual(ALLOWED_KEYS);
      expect(typeof e.body, `${label}: body is a string`).toBe("string");
      expect(typeof e.is_host, `${label}: is_host is a boolean`).toBe("boolean");
    }
  }

  /** The body strings present in a feed (membership / ordering checks). */
  function bodies(data: CommentEntry[] | null): string[] {
    return (data ?? []).map((e) => e.body);
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();
    expect(hostB?.id, "need >=2 host sessions (host B, for the account / non-owner branch)").toBeTruthy();

    // Signatures are pinned (SCHEMA RPC table). The independent test relies on these
    // exact arg names for its .rpc bodies; a rename/reorder is itself a contract break.
    // Crucially add_comment exposes NO guest_id/host_id param — a forged author has
    // nowhere to land (§1.5d 作者伪造), and NO gif param — gif is never client-supplied (D6).
    expect(inArgNames(FN_GET), "get_comments signature is pinned").toEqual(["slug", "guest_token"]);
    expect(inArgNames(FN_ADD), "add_comment signature is pinned (no guest_id/host_id/gif param)")
      .toEqual(["slug", "guest_token", "body", "client_fingerprint"]);

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);

    // Host profiles back the guests.user_id FK and supply a host comment's author name.
    // The auth.users trigger may have created them with a NULL display_name (the test
    // users carry no full_name metadata), so fill it ONLY when null — never clobber a
    // name another suite may rely on.
    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't15d host A'), ('${hostB.id}', 't15d host B')
         on conflict (id) do update
           set display_name = coalesce(public.profiles.display_name, excluded.display_name);`,
    );
    hostAName = scalar(runSql(`select display_name from public.profiles where id='${hostA.id}';`));

    // Events. visibility / rsvp_enabled / status vary per scenario; the rest default.
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, rsvp_enabled) values
         ('${hostA.id}','${E_PUBLIC}',   't15d public',    'public', 'published', true),
         ('${hostA.id}','${E_PRIVATE}',  't15d private',   'private','published', true),
         ('${hostA.id}','${E_RSVPOFF}',  't15d rsvpoff',   'public', 'published', false),
         ('${hostA.id}','${E_CROSS_A}',  't15d cross a',   'public', 'published', true),
         ('${hostA.id}','${E_CROSS_B}',  't15d cross b',   'public', 'published', true),
         ('${hostA.id}','${E_ACCOUNT}',  't15d account',   'public', 'published', true),
         ('${hostA.id}','${E_CANCELLED}','t15d cancelled', 'public', 'cancelled', true),
         ('${hostA.id}','${E_RL}',       't15d ratelimit', 'public', 'published', true);`,
    );

    // Guests. The going guest on E_PUBLIC carries the sentinel contact (a leak would
    // surface it). E_ACCOUNT's guest is linked to host B's account (user_id) so the
    // no-token account branch can unlock cross-device. E_RSVPOFF's guest is going —
    // proving even an unlocked guest is still host-only when rsvp_enabled=false.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact, user_id) values
         ((select id from public.events where slug='${E_PUBLIC}'),   '${T_GOING}'::uuid,    't15d-alice-going',   '${SENTINEL_CONTACT}', null),
         ((select id from public.events where slug='${E_PUBLIC}'),   '${T_MAYBE}'::uuid,    't15d-bob-maybe',     null, null),
         ((select id from public.events where slug='${E_PUBLIC}'),   '${T_WAIT}'::uuid,     't15d-carol-wait',    null, null),
         ((select id from public.events where slug='${E_PUBLIC}'),   '${T_NOTGOING}'::uuid, 't15d-dave-notgoing', null, null),
         ((select id from public.events where slug='${E_PUBLIC}'),   '${T_OTHER}'::uuid,    't15d-erin-other',    null, null),
         ((select id from public.events where slug='${E_PRIVATE}'),  '${T_PRIV}'::uuid,     't15d-priv-going',    null, null),
         ((select id from public.events where slug='${E_RSVPOFF}'),  '${T_RSVPOFF}'::uuid,  't15d-rsvpoff-going', null, null),
         ((select id from public.events where slug='${E_CROSS_A}'),  '${T_CROSS}'::uuid,    't15d-crossA-going',  null, null),
         ((select id from public.events where slug='${E_CROSS_B}'),  '${T_CROSSB}'::uuid,   't15d-crossB-going',  null, null),
         ((select id from public.events where slug='${E_ACCOUNT}'),  '${T_ACCT}'::uuid,     't15d-acct-guest',    null, '${hostB.id}'),
         ((select id from public.events where slug='${E_RL}'),       '${T_RL}'::uuid,       't15d-rl-going',      null, null);`,
    );

    // RSVPs — status keyed by each guest's deterministic token. plus_ones on the going
    // guest just to exercise a non-default value; it never reaches the feed.
    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_GOING}'::uuid    then 'going'
             when '${T_MAYBE}'::uuid    then 'maybe'
             when '${T_WAIT}'::uuid     then 'waitlisted'
             when '${T_NOTGOING}'::uuid then 'not_going'
             when '${T_OTHER}'::uuid    then 'going'
             when '${T_PRIV}'::uuid     then 'going'
             when '${T_RSVPOFF}'::uuid  then 'going'
             when '${T_CROSS}'::uuid    then 'going'
             when '${T_CROSSB}'::uuid   then 'going'
             when '${T_RL}'::uuid       then 'going'
             else 'going'
           end,
           case g.guest_token when '${T_GOING}'::uuid then 2 else 0 end
         from public.guests g
         join public.events e on e.id = g.event_id
         where e.slug like '${PREFIX}%';`,
    );

    // Pre-seeded comments. E_PUBLIC carries guest→host→guest in a fixed past order so
    // the read-open ordering (时间正序) is deterministic regardless of later inserts.
    // E_PRIVATE carries one comment that only the SSR (service_role) path may read.
    runSql(
      `insert into public.comments (event_id, guest_id, host_id, body, created_at)
         select e.id, g.id, null::uuid, '${B_GUEST1}', timestamptz '2020-01-01 00:00:01+00'
           from public.events e join public.guests g on g.event_id=e.id
          where e.slug='${E_PUBLIC}' and g.guest_token='${T_GOING}'::uuid
         union all
         select e.id, null::uuid, '${hostA.id}'::uuid, '${B_HOST}', timestamptz '2020-01-01 00:00:02+00'
           from public.events e where e.slug='${E_PUBLIC}'
         union all
         select e.id, g.id, null::uuid, '${B_GUEST2}', timestamptz '2020-01-01 00:00:03+00'
           from public.events e join public.guests g on g.event_id=e.id
          where e.slug='${E_PUBLIC}' and g.guest_token='${T_MAYBE}'::uuid
         union all
         select e.id, null::uuid, '${hostA.id}'::uuid, '${B_PRIVATE}', timestamptz '2020-01-01 00:00:01+00'
           from public.events e where e.slug='${E_PRIVATE}';`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    // ON DELETE CASCADE clears seeded guests/rsvps/comments with the event. rate_limits
    // rows are keyed by the (now-deleted) random event_id so they can't collide next run.
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  // ── §1.5d / §4.1 — READ IS OPEN: an un-RSVP'd (no-token) caller reads the feed ────
  it.skipIf(!LOCAL_UP)(
    "un-RSVP'd anon (NO token) CAN read the feed via get_comments (读开放) — desensitized, oldest→newest, host vs guest distinguished",
    async () => {
      const r = await callGet(anon(), E_PUBLIC);
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      const data = r.data ?? [];
      expectDesensitized(data, "read-open");

      // All three seeded comments are visible to a caller who never RSVP'd.
      const bs = bodies(data);
      expect(bs, "guest comment 1 readable").toContain(B_GUEST1);
      expect(bs, "host comment readable").toContain(B_HOST);
      expect(bs, "guest comment 2 readable").toContain(B_GUEST2);

      // 时间正序 (created_at asc): the seeded order is guest1 → host → guest2.
      const idx = (b: string) => bs.indexOf(b);
      expect(idx(B_GUEST1) < idx(B_HOST), "guest1 before host (oldest first)").toBe(true);
      expect(idx(B_HOST) < idx(B_GUEST2), "host before guest2 (oldest first)").toBe(true);

      // Authorship is surfaced as a name + an is_host badge — nothing linkable.
      const byBody = new Map(data.map((e) => [e.body, e]));
      expect(byBody.get(B_GUEST1)?.is_host, "guest comment ⇒ is_host=false").toBe(false);
      expect(byBody.get(B_GUEST1)?.author_display_name, "guest author name surfaced").toBe("t15d-alice-going");
      expect(byBody.get(B_HOST)?.is_host, "host comment ⇒ is_host=true").toBe(true);
      expect(byBody.get(B_HOST)?.author_display_name, "host author name surfaced").toBe(hostAName);
    },
  );

  // ── §1.5d — passing a token to get_comments must NOT change the (open) read ──────
  it.skipIf(!LOCAL_UP)(
    "get_comments is read-open: a not_going token, a forged token, and no token all return the SAME feed (the token never gates the read)",
    async () => {
      const base = bodies((await callGet(anon(), E_PUBLIC)).data).sort();
      const notgoing = bodies((await callGet(anon(), E_PUBLIC, T_NOTGOING)).data).sort();
      const forged = bodies((await callGet(anon(), E_PUBLIC, T_FORGED)).data).sort();
      expect(notgoing, "a not_going token does not gate the open read").toEqual(base);
      expect(forged, "a forged token does not gate the open read").toEqual(base);
    },
  );

  // ── §1.5d — unknown slug is not an existence oracle ──────────────────────────────
  it.skipIf(!LOCAL_UP)(
    "unknown slug ⇒ empty feed (same '[]' as a private-blocked / empty event — no existence oracle)",
    async () => {
      expectEmptyFeed(await callGet(anon(), "t15d-does-not-exist-xyz"), "unknown-slug");
    },
  );

  // ── §1.5d — PRIVATE feed (D3): only the trusted SSR path may read it ──────────────
  it.skipIf(!LOCAL_UP)(
    "a private event's feed is reachable ONLY via service_role (SSR): anon, anon WITH a valid unlock token, and the OWNER host all get [] — only service_role sees the comment",
    async () => {
      // anon, no token → blocked (private comments never leak on the open path).
      expectEmptyFeed(await callGet(anon(), E_PRIVATE), "private-anon");
      // anon WITH a real going token → STILL blocked: the D3 gate is by role, not unlock.
      expectEmptyFeed(await callGet(anon(), E_PRIVATE, T_PRIV), "private-anon-with-token");
      // Even the OWNER host, authenticated, gets [] here — the host reads the private
      // feed via direct ownership RLS, NOT this RPC.
      expectEmptyFeed(await callGet(asHost(hostA.accessToken), E_PRIVATE), "private-owner-host");

      // The trusted SSR path (service_role) is the ONLY caller that sees the feed.
      const ssr = await callGet(service(), E_PRIVATE);
      expect(ssr.res.error, JSON.stringify(ssr.res.error)).toBeNull();
      expect(bodies(ssr.data), "service_role (SSR) reads the private feed").toContain(B_PRIVATE);
      expectDesensitized(ssr.data ?? [], "private-ssr");
    },
  );

  // ── §1.5d (G1) — anon has NO direct table read: the RPC is the ONLY feed path ────
  it.skipIf(!LOCAL_UP)(
    "anon cannot SELECT the comments table directly — not even a PUBLIC event's comments — get_comments is the ONLY read path (G1)",
    async () => {
      const an = anon();
      const pubId = scalar(runSql(`select id from public.events where slug='${E_PUBLIC}';`));
      const privId = scalar(runSql(`select id from public.events where slug='${E_PRIVATE}';`));

      // Public event's comments exist, yet a direct table read leaks nothing (no anon policy).
      const pub = await an.from("comments").select("*").eq("event_id", pubId);
      expect((pub.data ?? []).length, "anon direct SELECT on comments must leak no rows (public)").toBe(0);
      // Private event likewise — and the private body must not surface anywhere.
      const priv = await an.from("comments").select("*").eq("event_id", privId);
      expect((priv.data ?? []).length, "anon direct SELECT on comments must leak no rows (private)").toBe(0);
      expect(JSON.stringify(priv.data ?? []), "private body unreachable via table read").not.toContain(B_PRIVATE);
    },
  );

  // ── §1.5d / §4.1 — WRITE GATE: locked callers are rejected, told to RSVP first ────
  it.skipIf(!LOCAL_UP)(
    "add_comment WRITE is gated: no token / forged token / a not_going RSVP are all rejected (RSVP required), and nothing is inserted",
    async () => {
      const an = anon();
      const before = commentCount(E_PUBLIC);

      // No token at all.
      const noTok = await callAdd(an, { slug: E_PUBLIC, body: "t15d-should-not-post-1", client_fingerprint: "w-notok" });
      expect(noTok.res.error, "no token ⇒ rejected").not.toBeNull();
      expect(noTok.res.error?.message, "the refusal tells the guest to RSVP first (§4.1)").toMatch(/RSVP/i);

      // Forged token (valid uuid, matches no guest).
      const forged = await callAdd(an, { slug: E_PUBLIC, guest_token: T_FORGED, body: "t15d-should-not-post-2", client_fingerprint: "w-forged" });
      expect(forged.res.error, "forged token ⇒ rejected").not.toBeNull();

      // A decliner (not_going) is NOT in the unlock set ⇒ rejected.
      const decline = await callAdd(an, { slug: E_PUBLIC, guest_token: T_NOTGOING, body: "t15d-should-not-post-3", client_fingerprint: "w-decline" });
      expect(decline.res.error, "not_going does NOT unlock ⇒ rejected").not.toBeNull();

      // None of the rejected attempts inserted a row.
      expect(commentCount(E_PUBLIC), "a rejected write inserts nothing").toBe(before);
    },
  );

  // ── §1.5d / §4.1 — happy path: an UNLOCKED guest posts and it appears in the feed ─
  it.skipIf(!LOCAL_UP)(
    "an unlocked GOING guest posts: confirmation is desensitized (is_host=false, no contact/token), gif_url stays null (D6), and it appears in the open feed",
    async () => {
      const an = anon();
      const body = "t15d-going-guest-posts";
      const r = await callAdd(an, { slug: E_PUBLIC, guest_token: T_GOING, body, client_fingerprint: "p-going" });
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expect(r.data, "a confirmation object is returned").not.toBeNull();

      // Confirmation is desensitized and bound to the token's guest (NOT a host).
      expectDesensitized([r.data as CommentEntry], "post-confirmation");
      expect(r.data?.is_host, "a guest comment is NOT a host comment").toBe(false);
      expect(r.data?.author_display_name, "author is the token's guest, server-resolved").toBe("t15d-alice-going");
      expect(r.data?.body, "body echoed").toBe(body);

      // D6: gif_url is NEVER written — the stored row's column is null.
      expect(gifUrlOf(r.data?.id as string), "add_comment never writes gif_url (D6)").toBe("<null>");

      // It surfaces on the open read path (下次轮询 / §4.1).
      const feed = await callGet(an, E_PUBLIC);
      expect(bodies(feed.data), "the new comment appears in the feed").toContain(body);
    },
  );

  // ── §1.5d — the rest of the unlock set: maybe AND waitlisted may also post ────────
  it.skipIf(!LOCAL_UP)(
    "maybe and waitlisted tokens also unlock the write (the unlock set is {going,maybe,waitlisted})",
    async () => {
      const an = anon();
      const maybe = await callAdd(an, { slug: E_PUBLIC, guest_token: T_MAYBE, body: "t15d-maybe-posts", client_fingerprint: "p-maybe" });
      expect(maybe.res.error, "maybe unlocks commenting").toBeNull();
      expect(maybe.data?.is_host).toBe(false);

      const wait = await callAdd(an, { slug: E_PUBLIC, guest_token: T_WAIT, body: "t15d-wait-posts", client_fingerprint: "p-wait" });
      expect(wait.res.error, "waitlisted unlocks commenting").toBeNull();
      expect(wait.data?.is_host).toBe(false);
    },
  );

  // ── §1.5d — AUTHOR BOUND SERVER-SIDE: a forged author cannot even be invoked ──────
  it.skipIf(!LOCAL_UP)(
    "a guest cannot forge the author: passing guest_id=<other>/host_id=<host> is rejected by PostgREST (no such param), and no impersonated comment is created",
    async () => {
      const an = anon();
      const otherGuestId = guestIdOf(T_OTHER); // the guest the attacker tries to impersonate
      const forgedBody = "t15d-forged-author-attempt";
      const before = commentCount(E_PUBLIC);

      // The guest holds a VALID going token (so the unlock gate would pass) but tries to
      // ride extra guest_id/host_id params to claim another guest / the host as author.
      const forged = await callAdd(an, {
        slug: E_PUBLIC,
        guest_token: T_GOING,
        body: forgedBody,
        client_fingerprint: "forge",
        extra: { guest_id: otherGuestId, host_id: hostA.id },
      });

      // add_comment has no guest_id/host_id param, so the forged call doesn't even match
      // a function signature — PostgREST refuses it (PGRST202). The impersonation param
      // has nowhere to land.
      expect(forged.res.error, "a forged-author call must be refused, not silently honoured").not.toBeNull();
      expect(
        `${forged.res.error?.code ?? ""} ${forged.res.error?.message ?? ""}`,
        "refusal is the missing-function (no such param) error, not an insert",
      ).toMatch(/PGRST202|could not find the function/i);

      // Nothing was inserted, and the forged body never appears authored by anyone.
      expect(commentCount(E_PUBLIC), "the forged attempt inserts nothing").toBe(before);
      const feed = await callGet(an, E_PUBLIC);
      expect(bodies(feed.data), "no comment from the forged attempt exists").not.toContain(forgedBody);
    },
  );

  // ── §1.5d — the host is bound from auth.uid(); a non-owner authed user is a guest ─
  it.skipIf(!LOCAL_UP)(
    "the event HOST may always comment (is_host=true, no RSVP needed); an arbitrary authenticated NON-owner who never unlocked is rejected",
    async () => {
      // Host A owns E_PUBLIC and never RSVP'd — yet may post; author bound from auth.uid().
      const hostPost = await callAdd(asHost(hostA.accessToken), { slug: E_PUBLIC, body: "t15d-host-posts-live", client_fingerprint: "h-post" });
      expect(hostPost.res.error, "the owner host may comment without RSVP").toBeNull();
      expect(hostPost.data?.is_host, "host comment ⇒ is_host=true").toBe(true);
      expect(hostPost.data?.author_display_name, "host author name from profiles").toBe(hostAName);

      // Host B is a logged-in user but NOT the owner of E_PUBLIC and has no RSVP there —
      // being merely authenticated must NOT grant commenting (no token → guest path → locked).
      const stranger = await callAdd(asHost(hostB.accessToken), { slug: E_PUBLIC, body: "t15d-stranger-should-not-post", client_fingerprint: "h-stranger" });
      expect(stranger.res.error, "an authenticated non-owner with no RSVP is rejected (not treated as host)").not.toBeNull();
      expect(stranger.res.error?.message, "rejected for lack of RSVP, not host privilege").toMatch(/RSVP/i);
    },
  );

  // ── §1.5d — account (user_id) unlock branch: logged in, NO token, treated as guest ─
  it.skipIf(!LOCAL_UP)(
    "a logged-in caller WITHOUT a token unlocks via their linked account (user_id) and posts as a GUEST (is_host=false — they don't own this event)",
    async () => {
      // Host B's account is linked to a going guest on E_ACCOUNT (which host A owns), so
      // host B — presenting NO token — unlocks via guests.user_id = auth.uid() and is
      // bound as that GUEST, not as a host (换设备凭账号认回 + non-owner ⇒ is_host=false).
      const r = await callAdd(asHost(hostB.accessToken), { slug: E_ACCOUNT, body: "t15d-account-posts", client_fingerprint: "acct" });
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expect(r.data?.is_host, "account-unlocked non-owner posts as a guest").toBe(false);
      expect(r.data?.author_display_name, "author bound to the account-linked guest").toBe("t15d-acct-guest");
    },
  );

  // ── §1.5d — cross-event token is worthless for the write (event-scoped gate) ──────
  it.skipIf(!LOCAL_UP)(
    "event A's token replayed on event B is rejected; B's own token works (proves the rejection is scope, not a broken event)",
    async () => {
      const an = anon();
      const beforeB = commentCount(E_CROSS_B);

      // T_CROSS belongs to E_CROSS_A; presented to E_CROSS_B it matches no guest ⇒ locked.
      const replay = await callAdd(an, { slug: E_CROSS_B, guest_token: T_CROSS, body: "t15d-cross-replay", client_fingerprint: "x-replay" });
      expect(replay.res.error, "cross-event token ⇒ not unlocked ⇒ rejected").not.toBeNull();
      expect(commentCount(E_CROSS_B), "the cross-event replay inserts nothing on B").toBe(beforeB);

      // Control: E_CROSS_B's OWN valid token DOES unlock — so the rejection above is the
      // event-scoped gate, not an unwritable event.
      const own = await callAdd(an, { slug: E_CROSS_B, guest_token: T_CROSSB, body: "t15d-cross-own", client_fingerprint: "x-own" });
      expect(own.res.error, "B's own token unlocks the write").toBeNull();
      expect(own.data?.is_host).toBe(false);
    },
  );

  // ── §1.5d / §4.1 — rsvp_enabled=false ⇒ HOST-ONLY: even an unlocked guest is refused ─
  it.skipIf(!LOCAL_UP)(
    "rsvp_enabled=false ⇒ host-only: a GOING (unlocked) guest is still rejected; only the host may post",
    async () => {
      const an = anon();
      const before = commentCount(E_RSVPOFF);

      // The guest IS going (would be unlocked elsewhere) — yet rsvp_enabled=false makes
      // commenting host-only, so the guest branch is refused outright (评论降级 host-only).
      const guest = await callAdd(an, { slug: E_RSVPOFF, guest_token: T_RSVPOFF, body: "t15d-rsvpoff-guest", client_fingerprint: "off-guest" });
      expect(guest.res.error, "rsvp_enabled=false ⇒ even an unlocked guest is host-only-rejected").not.toBeNull();
      expect(commentCount(E_RSVPOFF), "the rejected guest comment inserts nothing").toBe(before);

      // The host may still post on their own info-only event.
      const host = await callAdd(asHost(hostA.accessToken), { slug: E_RSVPOFF, body: "t15d-rsvpoff-host", client_fingerprint: "off-host" });
      expect(host.res.error, "the host may comment on an rsvp_enabled=false event").toBeNull();
      expect(host.data?.is_host, "host comment ⇒ is_host=true").toBe(true);
    },
  );

  // ── §1.5d 更狠 — a cancelled event accepts no comment (not even from the host) ─────
  it.skipIf(!LOCAL_UP)(
    "a cancelled event refuses add_comment (no row to write to), and an unknown slug errors",
    async () => {
      const host = await callAdd(asHost(hostA.accessToken), { slug: E_CANCELLED, body: "t15d-cancelled-host", client_fingerprint: "canc" });
      expect(host.res.error, "cancelled event ⇒ add_comment refused").not.toBeNull();
      expect(commentCount(E_CANCELLED), "nothing inserted on a cancelled event").toBe(0);

      const unknown = await callAdd(anon(), { slug: "t15d-no-such-slug", guest_token: T_GOING, body: "x", client_fingerprint: "miss" });
      expect(unknown.res.error, "unknown slug ⇒ error (no event to write to)").not.toBeNull();
    },
  );

  // ── §1.5d / §2.3.5 — write-side DB rate limit (D14/G7): the backstop bites Next-bypassers ─
  it.skipIf(!LOCAL_UP)(
    "an anon caller hammering add_comment directly is stopped by the DB rate_limits backstop (绕 Next 也拦)",
    async () => {
      const an = anon();
      // All calls share ONE rate bucket: same event + the SAME token (no fingerprint),
      // so the per-(event,identity) counter climbs across the burst. The guest is going
      // (unlocked), so under-cap attempts succeed; the over-cap attempts raise (and roll
      // back their own increment), so the committed counter parks at the cap and every
      // further attempt is refused. A generous burst guarantees crossing the cap within a
      // single fixed-minute window.
      const BURST = 60;
      const results = await Promise.all(
        Array.from({ length: BURST }, (_, k) =>
          callAdd(an, { slug: E_RL, guest_token: T_RL, body: `t15d-rl-${k}` }),
        ),
      );

      const limited = results.filter(
        (r) => r.res.error && /rate.?limit/i.test(r.res.error.message ?? ""),
      );
      expect(
        limited.length,
        "a burst past the cap must trip the DB rate limit at least once (write-side depth, D14)",
      ).toBeGreaterThan(0);
      expect(limited[0]?.res.error?.message, "the refusal is the add_comment rate limit").toMatch(/rate.?limit/i);
    },
  );

  // ── §1.5d (G1) — anon still has NO direct table write: only the RPC can write ─────
  it.skipIf(!LOCAL_UP)(
    "anon cannot INSERT into comments directly — the SECURITY DEFINER RPC is the ONLY write path (G1)",
    async () => {
      const an = anon();
      const evId = scalar(runSql(`select id from public.events where slug='${E_PUBLIC}';`));
      const guestId = guestIdOf(T_GOING);

      const direct = await an.from("comments").insert({ event_id: evId, guest_id: guestId, body: "t15d-direct-insert" });
      expect(direct.error, "anon direct INSERT into comments must be denied (no grant/policy)").not.toBeNull();
    },
  );
});
