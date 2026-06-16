import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.5b [SECURITY] — `submit_rsvp`, the single guest WRITE path
 * (migration 0008_submit_rsvp.sql, logical "0005c"; TEST-SPEC §1.5b).
 *
 * Written by the INDEPENDENT test agent (never wrote the implementation) with the
 * stance "assume this RPC oversells seats, leaks a neighbour's token, or lets a
 * bare contact hijack an existing guest". `anon` has NO direct privilege on
 * guests/rsvps (0004/0005), so EVERY public RSVP write flows through this one
 * SECURITY DEFINER function — a single missing branch oversells capacity, re-homes
 * a guest into the wrong account, or hands the attacker an existing guest's token.
 * The pinned contract (SCHEMA 安全模型 §2 单一写路径 + §4 去重逻辑 + §5 容量逻辑;
 * D1/D7①/D14/D15; G1/G7) is hammered from every angle:
 *
 *   1. DEDUP (D1). token (event-scoped) → linked account (user_id=auth.uid()) →
 *      brand-new guest. `contact` NEVER matches: a bare contact equal to an
 *      existing guest's makes an INDEPENDENT new row and returns the NEW token —
 *      it can never silently take over a guest or leak that guest's token. A
 *      token-bearing edit can never re-home the guest into a different account.
 *      A cross-event token is worthless (event-scoped) — it makes a fresh guest,
 *      it is NOT honoured as the new row's token.
 *   2. CAPACITY / WAITLIST (D7①). Serial fill: the (N+1)-th 'going' lands
 *      'waitlisted'. CONCURRENT N+5: exactly N go, the rest waitlist — the
 *      pg_advisory_xact_lock makes oversell impossible. Occupancy counts going
 *      INCLUDING plus-ones and EXCLUDES the caller's own row (an edit never
 *      double-counts) and maybe/not_going (they never consume a seat).
 *   3. CONFIRMATION (D15). A success returns the caller's OWN token + the CONFIRMED
 *      status (may be 'waitlisted' though 'going' was asked) — and never a
 *      third-tier field (another guest's token/contact).
 *   4. WRITE-SIDE DEPTH RATE LIMIT (D14/G7). An anon caller hammering the RPC
 *      directly (bypassing the Next/Upstash read limiter) is still stopped by the
 *      DB `rate_limits` backstop — "绕 Next 也拦".
 *   5. INPUT IS UNTRUSTED. 'waitlisted' is a server OUTCOME, never a client intent;
 *      a blank display_name, a disabled/cancelled event, and out-of-range plus_ones
 *      are all rejected or clamped server-side (not just in the UI).
 *
 * Calls go over PostgREST (.rpc) on the real role paths — anon is the browser
 * guest, an authenticated session exercises the account/user_id branch, service is
 * the trusted SSR path — because auth.uid() only reflects the caller's JWT over
 * that wire. Seeding is done as the postgres superuser (psql): with Supabase
 * auto-expose OFF, anon/service have no API grant on events/guests/rsvps so
 * PostgREST can't INSERT them; only the SECURITY DEFINER RPC can. Same pattern as
 * the 1.1–1.5a suites. Gated on a reachable local stack so the file skips (green)
 * without Docker; where the stack IS up, the gate must really hold.
 */
const LOCAL_UP = localStackRunning();

const FN = "submit_rsvp";

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

/** Number of guest rows on an event (dedup must not grow this when it shouldn't). */
function guestCount(slug: string): number {
  return Number(
    scalar(
      runSql(
        `select count(*) from public.guests g
           join public.events e on e.id=g.event_id where e.slug='${slug}';`,
      ),
    ),
  );
}

/** Number of 'going' RSVPs on an event (capacity oversell would push this past N). */
function goingCount(slug: string): number {
  return Number(
    scalar(
      runSql(
        `select count(*) from public.rsvps r
           join public.events e on e.id=r.event_id where e.slug='${slug}' and r.status='going';`,
      ),
    ),
  );
}

// A PostgREST response, structurally — { data, error } is all we read.
type ApiResult = { data: unknown; error: { message?: string } | null };
/** submit_rsvp's pinned confirmation shape (D15). */
interface Submit {
  event_id: string;
  guest_id: string;
  guest_token: string;
  status: string;
  plus_ones: number;
  waitlisted: boolean;
}

// ── Sentinels — unique enough to prove a specific value never crosses a boundary.
const PREFIX = "t15b"; // cleanup deletes every event whose title/slug starts here
const SENTINEL_CONTACT = "t15b-contact-secret@sentinel.invalid"; // host-only; never an identity

// Per-scenario events (separate so each scenario's guest/going counts are isolated).
const E_SERIAL = "t15b-serial"; // cap 2 — serial fill → waitlist
const E_CONC = "t15b-concurrent"; // cap 5 — parallel N+5, no oversell
const E_PLUS = "t15b-plusones"; // cap 4, +ones on — plus-ones consume seats
const E_CLAMP_OFF = "t15b-clamp-off"; // +ones OFF — plus_ones clamped to 0
const E_CLAMP_MAX = "t15b-clamp-max"; // +ones on, max 2 — plus_ones clamped to max / floored at 0
const E_MAYBECAP = "t15b-maybecap"; // cap 1 — maybe/not_going never consume a seat
const E_EDITCAP = "t15b-editcap"; // cap 1 — an edit must not double-count own row
const E_DEDUP = "t15b-dedup"; // cap null — token dedup (no new row)
const E_DEDUP_USER = "t15b-dedup-user"; // cap null — account/user_id dedup
const E_HIJACK = "t15b-hijack"; // cap null — bare-contact anti-hijack
const E_RL = "t15b-ratelimit"; // cap null — write-side DB rate limit
const E_RSVPOFF = "t15b-rsvpoff"; // rsvp_enabled=false — RSVP rejected
const E_CANCELLED = "t15b-cancelled"; // status=cancelled — RSVP rejected
const E_REHOME = "t15b-rehome"; // cap null — token edit must not re-home account
const E_CROSS_A = "t15b-cross-a"; // token lives here…
const E_CROSS_B = "t15b-cross-b"; // …and is replayed against here (event-scoped)
const E_OPEN = "t15b-open"; // cap null — return shape / input validation

// Fixed guest_token uuids so forged / cross-event / pre-seeded probes are deterministic.
const T_HIJACK = "15b00000-0000-4000-8000-000000000001"; // the victim guest on E_HIJACK
const T_RL = "15b00000-0000-4000-8000-000000000002"; // the bucket-sharing guest on E_RL
const T_RH = "15b00000-0000-4000-8000-000000000003"; // a guest already linked to host A on E_REHOME
const T_CROSS = "15b00000-0000-4000-8000-000000000004"; // a guest on E_CROSS_A, replayed on E_CROSS_B

describe("task 1.5b [SECURITY]: submit_rsvp guest write path (TEST-SPEC §1.5b)", () => {
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

  /** Call submit_rsvp over PostgREST; omit a field to leave it at its SQL default. */
  async function callSubmit(
    client: SupabaseClient,
    args: {
      slug: string;
      display_name: string;
      status?: string;
      guest_token?: string;
      plus_ones?: number;
      contact?: string;
      client_fingerprint?: string;
    },
  ): Promise<{ res: ApiResult; data: Submit | null }> {
    const body: Record<string, unknown> = {
      slug: args.slug,
      display_name: args.display_name,
    };
    if (args.status !== undefined) body.status = args.status;
    if (args.guest_token !== undefined) body.guest_token = args.guest_token;
    if (args.plus_ones !== undefined) body.plus_ones = args.plus_ones;
    if (args.contact !== undefined) body.contact = args.contact;
    if (args.client_fingerprint !== undefined) body.client_fingerprint = args.client_fingerprint;
    const res = (await client.rpc(FN, body)) as ApiResult;
    return { res, data: (res.data as Submit) ?? null };
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();
    expect(hostB?.id, "need >=2 host sessions (host B, for the account/user_id branch)").toBeTruthy();

    // Signature is pinned (SCHEMA RPC table). The independent test relies on these
    // exact arg names for its .rpc bodies; a rename/reorder is itself a contract break.
    expect(inArgNames(FN), "submit_rsvp signature is pinned").toEqual([
      "slug",
      "display_name",
      "status",
      "guest_token",
      "plus_ones",
      "contact",
      "client_fingerprint",
    ]);

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);

    // Host profiles back the guests.user_id FK; the auth.users trigger creates them,
    // upsert defensively regardless of trigger timing.
    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't15b host A'), ('${hostB.id}', 't15b host B')
         on conflict (id) do nothing;`,
    );

    // Events. capacity / allow_plus_ones / max_plus_ones / rsvp_enabled / status vary
    // per scenario; everything else takes its column default.
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, capacity, allow_plus_ones, max_plus_ones, rsvp_enabled) values
         ('${hostA.id}','${E_SERIAL}',     't15b serial',     'public','published', 2,    false, 1, true),
         ('${hostA.id}','${E_CONC}',        't15b concurrent', 'public','published', 5,    false, 1, true),
         ('${hostA.id}','${E_PLUS}',        't15b plusones',   'public','published', 4,    true,  3, true),
         ('${hostA.id}','${E_CLAMP_OFF}',   't15b clamp off',  'public','published', null, false, 1, true),
         ('${hostA.id}','${E_CLAMP_MAX}',   't15b clamp max',  'public','published', null, true,  2, true),
         ('${hostA.id}','${E_MAYBECAP}',    't15b maybecap',   'public','published', 1,    false, 1, true),
         ('${hostA.id}','${E_EDITCAP}',     't15b editcap',    'public','published', 1,    false, 1, true),
         ('${hostA.id}','${E_DEDUP}',       't15b dedup',      'public','published', null, true,  3, true),
         ('${hostA.id}','${E_DEDUP_USER}',  't15b dedup user', 'public','published', null, false, 1, true),
         ('${hostA.id}','${E_HIJACK}',      't15b hijack',     'public','published', null, false, 1, true),
         ('${hostA.id}','${E_RL}',          't15b ratelimit',  'public','published', null, false, 1, true),
         ('${hostA.id}','${E_RSVPOFF}',     't15b rsvpoff',    'public','published', null, false, 1, false),
         ('${hostA.id}','${E_CANCELLED}',   't15b cancelled',  'public','cancelled', null, false, 1, true),
         ('${hostA.id}','${E_REHOME}',      't15b rehome',     'public','published', null, false, 1, true),
         ('${hostA.id}','${E_CROSS_A}',     't15b cross a',    'public','published', null, false, 1, true),
         ('${hostA.id}','${E_CROSS_B}',     't15b cross b',    'public','published', null, false, 1, true),
         ('${hostA.id}','${E_OPEN}',        't15b open',       'public','published', null, true,  3, true);`,
    );

    // Pre-seeded guests for the anti-hijack / rate-limit / re-home / cross-event probes.
    // (The dedup-by-RPC scenarios create their guests through submit_rsvp itself.)
    //  - HIJACK victim carries the sentinel contact: an attacker re-using that contact
    //    must NOT touch this row nor get its token back.
    //  - RL guest shares one rate-limit bucket (matched by its token) across a burst.
    //  - REHOME guest is ALREADY linked to host A: a token edit by host B must keep
    //    user_id = host A (coalesce, no re-home).
    //  - CROSS guest lives on event A; its token replayed on event B must not match.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact, user_id) values
         ((select id from public.events where slug='${E_HIJACK}'),  '${T_HIJACK}'::uuid, 't15b victim',   '${SENTINEL_CONTACT}', null),
         ((select id from public.events where slug='${E_RL}'),       '${T_RL}'::uuid,     't15b rl',       null,                  null),
         ((select id from public.events where slug='${E_REHOME}'),   '${T_RH}'::uuid,     't15b rehomed',  null,                  '${hostA.id}'),
         ((select id from public.events where slug='${E_CROSS_A}'),  '${T_CROSS}'::uuid,  't15b cross',    null,                  null);`,
    );
    // Give the victim / re-home / cross guests a real going RSVP so "unchanged" is meaningful.
    runSql(
      `insert into public.rsvps (event_id, guest_id, status)
         select g.event_id, g.id, 'going' from public.guests g
          where g.guest_token in ('${T_HIJACK}'::uuid,'${T_RH}'::uuid,'${T_CROSS}'::uuid);`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    // ON DELETE CASCADE clears seeded guests/rsvps with the event. rate_limits rows
    // are keyed by the (now-deleted) random event_id so they cannot collide next run.
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  // ── §1.5b — serial capacity: under capacity ⇒ going; the (N+1)-th going ⇒ waitlisted ──
  it.skipIf(!LOCAL_UP)(
    "capacity=2: serial going submits fill the 2 seats ('going'), the 3rd lands 'waitlisted'",
    async () => {
      const an = anon();
      // Distinct fingerprints ⇒ distinct rate buckets, distinct (no-token) guests.
      const a = await callSubmit(an, { slug: E_SERIAL, display_name: "s-a", client_fingerprint: "s-a" });
      expect(a.res.error, JSON.stringify(a.res.error)).toBeNull();
      expect(a.data?.status, "seat 1 of 2 ⇒ going").toBe("going");
      expect(a.data?.waitlisted).toBe(false);

      const b = await callSubmit(an, { slug: E_SERIAL, display_name: "s-b", client_fingerprint: "s-b" });
      expect(b.data?.status, "seat 2 of 2 ⇒ going").toBe("going");

      const c = await callSubmit(an, { slug: E_SERIAL, display_name: "s-c", client_fingerprint: "s-c" });
      expect(c.res.error, JSON.stringify(c.res.error)).toBeNull();
      expect(c.data?.status, "capacity full ⇒ the next going is waitlisted (D7①)").toBe("waitlisted");
      expect(c.data?.waitlisted, "waitlisted flag mirrors the status").toBe(true);

      // The DB itself must never hold more than `capacity` going rows.
      expect(goingCount(E_SERIAL), "exactly the 2 seats are 'going' in the DB").toBe(2);
    },
  );

  // ── §1.5b — CONCURRENT (D7①): N+5 parallel going on capacity=N ⇒ exactly N going ──
  it.skipIf(!LOCAL_UP)(
    "capacity=5: 10 PARALLEL going submits ⇒ exactly 5 going, 5 waitlisted (advisory lock ⇒ no oversell)",
    async () => {
      const an = anon();
      const N = 5;
      const total = N + 5;
      // Fire all at once: each a distinct (no-token) guest in its own rate bucket, so
      // ONLY the per-event advisory lock can serialise the capacity decision. Without
      // the lock, racing readers all see <capacity and all go 'going' (oversell).
      const results = await Promise.all(
        Array.from({ length: total }, (_, k) =>
          callSubmit(an, {
            slug: E_CONC,
            display_name: `c-${k}`,
            status: "going",
            client_fingerprint: `c-${k}`,
          }),
        ),
      );

      const errored = results.filter((r) => r.res.error);
      expect(errored.map((r) => r.res.error?.message), "no submit should error").toEqual([]);

      const going = results.filter((r) => r.data?.status === "going").length;
      const waitlisted = results.filter((r) => r.data?.status === "waitlisted").length;
      expect(going, "exactly capacity(5) winners — never an oversell under the race").toBe(N);
      expect(waitlisted, "the remaining 5 are waitlisted").toBe(total - N);

      // Authoritative cross-check against the DB (not just the returned values).
      expect(goingCount(E_CONC), "the DB holds exactly 5 going rows — no oversell").toBe(N);
    },
  );

  // ── §1.5b 更狠 — plus-ones consume seats; occupancy = sum(1 + plus_ones) over going ──
  it.skipIf(!LOCAL_UP)(
    "capacity=4: a going +2 (occupies 3) then a going +0 (occupies 4) fit; the next going +0 waitlists",
    async () => {
      const an = anon();
      const a = await callSubmit(an, {
        slug: E_PLUS, display_name: "p-a", status: "going", plus_ones: 2, client_fingerprint: "p-a",
      });
      expect(a.res.error, JSON.stringify(a.res.error)).toBeNull();
      expect(a.data?.status, "1+2=3 ≤ 4 ⇒ going").toBe("going");
      expect(a.data?.plus_ones, "plus_ones honoured (max 3)").toBe(2);

      const b = await callSubmit(an, {
        slug: E_PLUS, display_name: "p-b", status: "going", plus_ones: 0, client_fingerprint: "p-b",
      });
      expect(b.data?.status, "occupancy 3 + 1 = 4 ≤ 4 ⇒ going (fills the last seat)").toBe("going");

      const c = await callSubmit(an, {
        slug: E_PLUS, display_name: "p-c", status: "going", plus_ones: 0, client_fingerprint: "p-c",
      });
      expect(c.data?.status, "occupancy 4 + 1 = 5 > 4 ⇒ waitlisted (plus-ones counted)").toBe("waitlisted");
    },
  );

  // ── §1.5b 更狠 — maybe/not_going never consume a seat; a going-when-full still waitlists ──
  it.skipIf(!LOCAL_UP)(
    "capacity=1: one going fills it; a later maybe stays 'maybe' and a not_going stays 'not_going' (no seat consumed); a 2nd going waitlists",
    async () => {
      const an = anon();
      const go = await callSubmit(an, { slug: E_MAYBECAP, display_name: "m-go", status: "going", client_fingerprint: "m-go" });
      expect(go.data?.status, "the single seat ⇒ going").toBe("going");

      const maybe = await callSubmit(an, { slug: E_MAYBECAP, display_name: "m-maybe", status: "maybe", client_fingerprint: "m-maybe" });
      expect(maybe.res.error, JSON.stringify(maybe.res.error)).toBeNull();
      expect(maybe.data?.status, "maybe is never waitlisted by capacity").toBe("maybe");

      const no = await callSubmit(an, { slug: E_MAYBECAP, display_name: "m-no", status: "not_going", client_fingerprint: "m-no" });
      expect(no.data?.status, "not_going is never waitlisted by capacity").toBe("not_going");

      const go2 = await callSubmit(an, { slug: E_MAYBECAP, display_name: "m-go2", status: "going", client_fingerprint: "m-go2" });
      expect(go2.data?.status, "the seat is taken (maybe/not_going didn't consume it) ⇒ waitlisted").toBe("waitlisted");

      expect(goingCount(E_MAYBECAP), "still exactly 1 going — maybe/not_going never counted").toBe(1);
    },
  );

  // ── §1.5b 更狠 — an EDIT must not double-count the caller's own row ───────────────
  it.skipIf(!LOCAL_UP)(
    "capacity=1: a going guest re-submitting 'going' STAYS going (own row excluded from occupancy — no self-inflicted waitlist)",
    async () => {
      const an = anon();
      const first = await callSubmit(an, { slug: E_EDITCAP, display_name: "e1", status: "going", client_fingerprint: "e1" });
      expect(first.data?.status, "fills the only seat").toBe("going");
      const token = first.data?.guest_token as string;

      // Same guest (its token) edits again. If occupancy counted its OWN going row,
      // it would see 1 ≥ capacity and wrongly demote itself to waitlisted.
      const edit = await callSubmit(an, { slug: E_EDITCAP, display_name: "e1-renamed", status: "going", guest_token: token });
      expect(edit.res.error, JSON.stringify(edit.res.error)).toBeNull();
      expect(edit.data?.status, "editing own RSVP must not waitlist oneself").toBe("going");
      expect(edit.data?.guest_id, "still the same guest").toBe(first.data?.guest_id);
      expect(goingCount(E_EDITCAP), "still exactly 1 going row after the edit").toBe(1);
    },
  );

  // ── §1.5b 更狠 — plus_ones is clamped server-side (not just the UI) ───────────────
  it.skipIf(!LOCAL_UP)(
    "plus_ones is clamped: allow_plus_ones=false ⇒ forced to 0; max_plus_ones=2 ⇒ capped at 2; negative ⇒ floored at 0",
    async () => {
      const an = anon();
      // +ones turned OFF: a request for 5 extras is forced to 0.
      const off = await callSubmit(an, { slug: E_CLAMP_OFF, display_name: "off", status: "going", plus_ones: 5, client_fingerprint: "off" });
      expect(off.res.error, JSON.stringify(off.res.error)).toBeNull();
      expect(off.data?.plus_ones, "allow_plus_ones=false ⇒ plus_ones clamped to 0").toBe(0);

      // +ones on, max 2: a request for 5 is capped at 2.
      const cap = await callSubmit(an, { slug: E_CLAMP_MAX, display_name: "cap", status: "going", plus_ones: 5, client_fingerprint: "cap" });
      expect(cap.data?.plus_ones, "plus_ones capped at max_plus_ones (2)").toBe(2);

      // A negative request is floored at 0 (and never violates the rsvps plus_ones>=0 check).
      const neg = await callSubmit(an, { slug: E_CLAMP_MAX, display_name: "neg", status: "going", plus_ones: -3, client_fingerprint: "neg" });
      expect(neg.res.error, "negative plus_ones must be floored, not rejected by the check constraint").toBeNull();
      expect(neg.data?.plus_ones, "negative plus_ones floored to 0").toBe(0);
    },
  );

  // ── §1.5b — token dedup: a 2nd submit with the returned token updates, never new ──
  it.skipIf(!LOCAL_UP)(
    "same guest_token re-submit updates the SAME guest+rsvp (guests row count does not grow)",
    async () => {
      const an = anon();
      const before = guestCount(E_DEDUP);

      const first = await callSubmit(an, { slug: E_DEDUP, display_name: "d1", status: "going", plus_ones: 1, client_fingerprint: "d1" });
      expect(first.res.error, JSON.stringify(first.res.error)).toBeNull();
      const token = first.data?.guest_token as string;
      expect(guestCount(E_DEDUP), "first submit creates exactly one guest").toBe(before + 1);

      // Re-submit with the token, changing status + plus_ones: an UPDATE, not a new row.
      const second = await callSubmit(an, { slug: E_DEDUP, display_name: "d1-edited", status: "maybe", plus_ones: 2, guest_token: token });
      expect(second.res.error, JSON.stringify(second.res.error)).toBeNull();
      expect(second.data?.guest_id, "same guest is updated, not duplicated").toBe(first.data?.guest_id);
      expect(second.data?.guest_token, "the same token is returned").toBe(token);
      expect(second.data?.status, "status updated to maybe").toBe("maybe");
      expect(second.data?.plus_ones, "plus_ones updated to 2").toBe(2);
      expect(guestCount(E_DEDUP), "no new guest row on a token re-submit (dedup)").toBe(before + 1);
    },
  );

  // ── §1.5b — account dedup (D1): logged-in caller, no token, recognised by user_id ──
  it.skipIf(!LOCAL_UP)(
    "logged-in caller WITHOUT a token (new device) updates their existing guest via user_id=auth.uid() — no new row",
    async () => {
      const b = asHost(hostB.accessToken);
      const before = guestCount(E_DEDUP_USER);

      // First RSVP while logged in: server fills user_id from auth.uid() (client never sends it).
      const first = await callSubmit(b, { slug: E_DEDUP_USER, display_name: "u1", status: "going", client_fingerprint: "u1" });
      expect(first.res.error, JSON.stringify(first.res.error)).toBeNull();
      expect(guestCount(E_DEDUP_USER), "first logged-in submit creates one guest").toBe(before + 1);

      // New device: NO token, but the SAME account. Must re-find the guest by user_id.
      const second = await callSubmit(b, { slug: E_DEDUP_USER, display_name: "u1-newdevice", status: "maybe" });
      expect(second.res.error, JSON.stringify(second.res.error)).toBeNull();
      expect(second.data?.guest_id, "account branch re-finds the same guest (cross-device)").toBe(first.data?.guest_id);
      expect(second.data?.status).toBe("maybe");
      expect(guestCount(E_DEDUP_USER), "no new guest — account dedup, not a duplicate").toBe(before + 1);
    },
  );

  // ── §1.5b — bare-contact ANTI-HIJACK (D1, the headline): never matches identity ──
  it.skipIf(!LOCAL_UP)(
    "a bare contact equal to an existing guest's makes a NEW independent row; the victim is untouched; the victim's token is never returned",
    async () => {
      const an = anon();
      const victimId = scalar(runSql(`select id from public.guests where guest_token='${T_HIJACK}'::uuid;`));
      const before = guestCount(E_HIJACK);

      // Attacker: NO token, NOT logged in, but the SAME contact as the victim.
      const attack = await callSubmit(an, {
        slug: E_HIJACK,
        display_name: "attacker",
        status: "going",
        contact: SENTINEL_CONTACT,
        client_fingerprint: "attacker",
      });
      expect(attack.res.error, JSON.stringify(attack.res.error)).toBeNull();

      // A brand-new, independent guest — contact NEVER matched (D1).
      expect(attack.data?.guest_id, "contact must not resolve to the victim").not.toBe(victimId);
      expect(guestCount(E_HIJACK), "a NEW independent guest row is created").toBe(before + 1);

      // The victim's token must NEVER be handed back (no hijack / no token leak).
      expect(attack.data?.guest_token, "the attacker gets a fresh token, never the victim's").not.toBe(T_HIJACK);
      expect(JSON.stringify(attack.data), "the victim's token must not ride along anywhere").not.toContain(T_HIJACK);

      // The victim row is byte-for-byte unchanged (name/contact/token preserved).
      const victim = runSql(
        `select display_name || '|' || coalesce(contact,'') || '|' || guest_token
           from public.guests where id='${victimId}';`,
      ).trim();
      expect(victim, "the victim guest is untouched by the bare-contact submit").toBe(
        `t15b victim|${SENTINEL_CONTACT}|${T_HIJACK}`,
      );
    },
  );

  // ── §1.5b 更狠 — a token edit must not RE-HOME the guest into a different account ──
  it.skipIf(!LOCAL_UP)(
    "host B editing a guest already linked to host A keeps user_id = host A (coalesce — a token edit cannot steal the account link)",
    async () => {
      // The token is the credential, so host B (holding it) may edit the RSVP — but the
      // guest's pre-existing account link (host A) must survive (user_id only fills when null).
      const edit = await callSubmit(asHost(hostB.accessToken), {
        slug: E_REHOME,
        display_name: "rehome-attempt",
        status: "maybe",
        guest_token: T_RH,
      });
      expect(edit.res.error, JSON.stringify(edit.res.error)).toBeNull();
      expect(edit.data?.status, "the token holder can edit the RSVP").toBe("maybe");

      const ownerUid = scalar(runSql(`select user_id from public.guests where guest_token='${T_RH}'::uuid;`));
      expect(ownerUid, "user_id stays host A — a token edit cannot re-home the guest to host B").toBe(hostA.id);
    },
  );

  // ── §1.5b 更狠 — a cross-event token is worthless: it makes a fresh guest, scoped ──
  it.skipIf(!LOCAL_UP)(
    "event A's token replayed on event B does NOT match — a new guest is created on B with a FRESH token; event A's guest is untouched",
    async () => {
      const an = anon();
      const beforeB = guestCount(E_CROSS_B);
      const crossId = scalar(runSql(`select id from public.guests where guest_token='${T_CROSS}'::uuid;`));

      const replay = await callSubmit(an, {
        slug: E_CROSS_B,
        display_name: "replayer",
        status: "going",
        guest_token: T_CROSS, // belongs to E_CROSS_A, not E_CROSS_B
        client_fingerprint: "replay",
      });
      expect(replay.res.error, JSON.stringify(replay.res.error)).toBeNull();

      // Event-scoped dedup: no match on B ⇒ a brand-new guest, and the replayed token is
      // NOT honoured as the new row's token (server mints a fresh one).
      expect(replay.data?.guest_id, "cross-event token must not resolve to A's guest").not.toBe(crossId);
      expect(replay.data?.guest_token, "the server mints a fresh token, not the replayed one").not.toBe(T_CROSS);
      expect(guestCount(E_CROSS_B), "a new guest is created on event B").toBe(beforeB + 1);

      // Event A's guest must be entirely untouched by the cross-event replay.
      const onA = scalar(runSql(`select count(*) from public.guests where guest_token='${T_CROSS}'::uuid;`));
      expect(onA, "event A's guest still exists, unique, untouched").toBe("1");
    },
  );

  // ── §1.5b — confirmation (D15): success returns OWN token + confirmed status only ──
  it.skipIf(!LOCAL_UP)(
    "a successful submit returns the caller's own guest_token + confirmed status, and never a third-tier field",
    async () => {
      const ok = await callSubmit(anon(), { slug: E_OPEN, display_name: "ret", status: "going", client_fingerprint: "ret" });
      expect(ok.res.error, JSON.stringify(ok.res.error)).toBeNull();
      expect(ok.data, "a confirmation object is returned").not.toBeNull();

      // token is a real uuid the client can persist + edit with later.
      expect(ok.data?.guest_token, "own token returned (D15)").toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(ok.data?.status, "confirmed status echoed").toBe("going");
      expect(typeof ok.data?.waitlisted, "waitlisted flag present").toBe("boolean");
      expect(ok.data?.guest_id, "the matched guest id is returned").toBeTruthy();

      // A confirmed waitlist must report the SERVER outcome, not the requested status —
      // proven on the already-full serial event (capacity 2 was filled above).
      const wl = await callSubmit(anon(), { slug: E_SERIAL, display_name: "ret-wl", status: "going", client_fingerprint: "ret-wl" });
      expect(wl.data?.status, "going requested but full ⇒ confirmed status is waitlisted").toBe("waitlisted");
      expect(wl.data?.waitlisted).toBe(true);

      // No third-tier leakage: contact / other guests' tokens never appear in the body.
      expect(Object.prototype.hasOwnProperty.call(ok.data ?? {}, "contact"), "no contact in the confirmation").toBe(false);
      expect(JSON.stringify(ok.data), "the host-only sentinel contact must never appear").not.toContain(SENTINEL_CONTACT);
    },
  );

  // ── §1.5b — input is untrusted: 'waitlisted' is a server outcome, blank name rejected ──
  it.skipIf(!LOCAL_UP)(
    "rejects a client-supplied 'waitlisted'/garbage status and a blank display_name (the function is the trust boundary)",
    async () => {
      const an = anon();

      // 'waitlisted' is a SERVER decision, never a client intent — must be rejected.
      const wl = await callSubmit(an, { slug: E_OPEN, display_name: "x", status: "waitlisted", client_fingerprint: "v-wl" });
      expect(wl.res.error, "client-requested 'waitlisted' must be rejected").not.toBeNull();

      // Garbage status.
      const bad = await callSubmit(an, { slug: E_OPEN, display_name: "x", status: "definitely-coming", client_fingerprint: "v-bad" });
      expect(bad.res.error, "an unknown status must be rejected").not.toBeNull();

      // Blank / whitespace-only display_name (guests.display_name is NOT NULL).
      const blank = await callSubmit(an, { slug: E_OPEN, display_name: "   ", status: "going", client_fingerprint: "v-blank" });
      expect(blank.res.error, "a blank display_name must be rejected").not.toBeNull();
    },
  );

  // ── §1.5b 更狠 — RSVP is refused when the event isn't accepting replies ───────────
  it.skipIf(!LOCAL_UP)(
    "submit is rejected on an rsvp_enabled=false event and on a cancelled event; an unknown slug errors (no row to write)",
    async () => {
      const an = anon();

      const off = await callSubmit(an, { slug: E_RSVPOFF, display_name: "x", status: "going", client_fingerprint: "off2" });
      expect(off.res.error, "rsvp_enabled=false ⇒ RSVP refused (只发信息不收回复)").not.toBeNull();
      expect(guestCount(E_RSVPOFF), "no guest created on a disabled-RSVP event").toBe(0);

      const cancelled = await callSubmit(an, { slug: E_CANCELLED, display_name: "x", status: "going", client_fingerprint: "canc" });
      expect(cancelled.res.error, "cancelled event ⇒ RSVP refused").not.toBeNull();
      expect(guestCount(E_CANCELLED), "no guest created on a cancelled event").toBe(0);

      const unknown = await callSubmit(an, { slug: "t15b-no-such-slug", display_name: "x", status: "going", client_fingerprint: "miss" });
      expect(unknown.res.error, "unknown slug ⇒ error (no event to write to)").not.toBeNull();
    },
  );

  // ── §1.5b — write-side DB rate limit (D14/G7): the backstop bites even bypassing Next ──
  it.skipIf(!LOCAL_UP)(
    "an anon caller hammering submit_rsvp directly is stopped by the DB rate_limits backstop (绕 Next 也拦)",
    async () => {
      const an = anon();
      // All calls share ONE rate bucket: same event + the SAME token (no fingerprint),
      // so the per-(event,identity) counter climbs across the burst. They all dedup to
      // the pre-seeded guest (no row churn). A generous burst over the cap guarantees the
      // counter crosses it within a single fixed-minute window; the over-cap attempts
      // raise (and roll back their own increment), so the committed counter parks at the
      // cap and every further attempt is refused.
      const BURST = 60;
      const results = await Promise.all(
        Array.from({ length: BURST }, () =>
          callSubmit(an, { slug: E_RL, display_name: "rl", status: "going", guest_token: T_RL }),
        ),
      );

      const limited = results.filter(
        (r) => r.res.error && /rate.?limit/i.test(r.res.error.message ?? ""),
      );
      expect(
        limited.length,
        "a burst past the cap must trip the DB rate limit at least once (write-side depth, D14)",
      ).toBeGreaterThan(0);

      // And it must be the rate limiter specifically — not some unrelated failure.
      expect(limited[0]?.res.error?.message, "the refusal is the submit rate limit").toMatch(/rate.?limit/i);
    },
  );

  // ── §1.5b — anon still has NO direct table write (G1): only the RPC can write ─────
  it.skipIf(!LOCAL_UP)(
    "anon cannot INSERT guests/rsvps directly — the SECURITY DEFINER RPC is the ONLY write path (G1)",
    async () => {
      const an = anon();
      const evId = scalar(runSql(`select id from public.events where slug='${E_OPEN}';`));

      const g = await an.from("guests").insert({ event_id: evId, display_name: "direct" });
      expect(g.error, "anon direct INSERT into guests must be denied (no grant/policy)").not.toBeNull();

      const r = await an.from("rsvps").insert({ event_id: evId, guest_id: evId, status: "going" });
      expect(r.error, "anon direct INSERT into rsvps must be denied").not.toBeNull();

      // The trusted SSR path (service_role) may also call the RPC — submit isn't anon-only.
      const ssr = await callSubmit(service(), { slug: E_OPEN, display_name: "ssr", status: "maybe", client_fingerprint: "ssr" });
      expect(ssr.res.error, JSON.stringify(ssr.res.error)).toBeNull();
      expect(ssr.data?.status, "service_role (trusted SSR) can submit too").toBe("maybe");
    },
  );
});
