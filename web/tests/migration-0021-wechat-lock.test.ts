import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Round-4 [SECURITY] — WeChat binding + event "lock" with deferred TWO-WAY,
 * EPHEMERAL contact reveal (migration 0021_wechat_lock_contact_reveal.sql).
 *
 * Written by the INDEPENDENT test agent (did NOT write the implementation) against
 * Appendix A of /tmp/round4-spec.md, treating the migration as a BLACK BOX. Stance:
 * "assume WeChat leaks before lock, leaks to a passerby, leaks guest↔guest, that
 * lock is reversible or non-host-callable, that the burn never fires, or that the
 * column revokes are paper". The DB is the security boundary, so every assertion
 * hits the real role paths over PostgREST (.rpc / .from): anon = the browser guest,
 * an authenticated session = the host, service = the trusted SSR path — auth.uid()/
 * auth.role() only reflect the caller's JWT over that wire.
 *
 * Seeding is done as the postgres superuser (psql): with auto-expose OFF, anon/
 * service have no API grant on events/guests/rsvps, and `authenticated` now also
 * has guests.wechat_id / events.locked_at column revokes — so PostgREST can't seed
 * them; only the DEFINER RPCs (or psql) can. Lock/burn windows are driven by
 * writing starts_at / ends_at / locked_at directly (pinning now() is impractical;
 * we choose times inside vs outside the 24h windows, per Appendix A items 6 & 7).
 *
 * Appendix A coverage map (each `it` is tagged [A#]):
 *   1  no pre-lock leak (host OR guest wechat), even to an RSVP'd/unlocked viewer
 *   2  is_locked always present on the normal payload, false pre-lock
 *   3  manual lock reveals two-way and ONLY to the right parties
 *   4  lock_event authz + irreversibility + column-revoke denial
 *   5  submit_rsvp wechat-required-for-going/maybe + rejected-after-lock
 *   6  auto-lock derivation via starts_at inside/outside 24h + date_tbd
 *   7  阅后即焚 burn: wechat gone >24h after effective end though is_locked stays true
 *   8  guests never see each other's wechat (get_guest_list has no wechat_id key)
 *   9  column hardening: authenticated can't select guests.wechat_id / update locked_at
 *  10  (existing tests fixed elsewhere — task-2.4a / task-2.4b)
 *
 * Gated on a reachable local stack so the file skips (green) without Docker; where
 * the stack IS up, the gate must really hold.
 */
const LOCAL_UP = localStackRunning();

const FN_LOCK = "lock_event";
const FN_CONTACTS = "get_event_guest_contacts";
const FN_SLUG = "get_event_by_slug";
const FN_RSVP = "submit_rsvp";
const FN_LIST = "get_guest_list";

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

/** Roles holding EXECUTE on a function (proacl), as a set of role names. */
function execGrantees(fn: string, sig: string): Set<string> {
  const out = runSql(
    `select coalesce(string_agg(distinct g.rolname, ','), '')
       from pg_proc p,
            lateral aclexplode(p.proacl) a
       join pg_roles g on g.oid = a.grantee
      where p.proname='${fn}' and p.pronamespace='public'::regnamespace
        and pg_get_function_identity_arguments(p.oid) = '${sig}'
        and a.privilege_type='EXECUTE';`,
  );
  return new Set(scalar(out).split(",").map((s) => s.trim()).filter(Boolean));
}

/** locked_at of an event by slug ('' when NULL). */
function lockedAt(slug: string): string {
  return scalar(
    runSql(`select coalesce(locked_at::text,'') from public.events where slug='${slug}';`),
  );
}

type ApiResult = { data: unknown; error: { message?: string } | null };
type EventObj = Record<string, unknown> | null;
type ContactsRow = { display_name: string; status: string; plus_ones: number; wechat_id: string };

// ── Sentinels — unique enough to prove a value never crosses a boundary. ───────────
const PREFIX = "r4wx";
const HOST_WX = "r4wx-HOST-wechat-SECRET"; // host's wechat (in profiles)
const GUEST_WX = "r4wx-GUEST-wechat-SECRET"; // an RSVP'd guest's wechat

// Per-scenario events.
const E_UNLOCKED = "r4wx-unlocked"; // not locked, far/no start — pre-lock leak probe
const E_LOCKED = "r4wx-locked"; // manually locked — two-way reveal
const E_AUTO_IN = "r4wx-auto-in"; // starts in 12h ⇒ auto-locked
const E_AUTO_OUT = "r4wx-auto-out"; // starts in 3d ⇒ not auto-locked
const E_TBD = "r4wx-tbd"; // date_tbd, no dates ⇒ never auto-locks
const E_BURNED = "r4wx-burned"; // locked, ended >24h ago ⇒ burned
const E_FRESH_END = "r4wx-freshend"; // locked, ended <24h ago ⇒ still open
const E_GATE = "r4wx-gate"; // submit_rsvp wechat-required probe
const E_LOCK_GATE = "r4wx-lockgate"; // locked ⇒ submit_rsvp closed
const E_AUTHZ = "r4wx-authz"; // lock_event authz / irreversibility
const E_COLHARD = "r4wx-colhard"; // column hardening probes

// Fixed guest tokens so unlocked-viewer probes are deterministic.
const T_RSVP = "4f000000-0000-4000-8000-000000000001"; // RSVP'd going on E_LOCKED/etc.

describe("round-4 [SECURITY]: wechat lock + two-way ephemeral reveal (migration 0021)", () => {
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

  /** get_event_by_slug over PostgREST; optionally with a guest token / viewer_id. */
  async function readSlug(
    client: SupabaseClient,
    slug: string,
    opts: { token?: string; viewerId?: string } = {},
  ): Promise<{ res: ApiResult; data: EventObj }> {
    const body: Record<string, unknown> = { slug };
    if (opts.token !== undefined) body.guest_token = opts.token;
    if (opts.viewerId !== undefined) body.viewer_id = opts.viewerId;
    const res = (await client.rpc(FN_SLUG, body)) as ApiResult;
    return { res, data: (res.data as EventObj) ?? null };
  }

  /** get_event_guest_contacts over PostgREST. Returns the jsonb array (or []). */
  async function readContacts(
    client: SupabaseClient,
    eventId: string,
  ): Promise<{ res: ApiResult; rows: ContactsRow[] }> {
    const res = (await client.rpc(FN_CONTACTS, { event_id: eventId })) as ApiResult;
    return { res, rows: (res.data as ContactsRow[] | null) ?? [] };
  }

  /** Resolve an event's id by slug (server superuser). */
  function eventId(slug: string): string {
    return scalar(runSql(`select id from public.events where slug='${slug}';`));
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();
    expect(hostB?.id, "need >=2 host sessions (host B, the non-host attacker)").toBeTruthy();

    // The deployed interface is the contract. Pin the new signatures so the .rpc
    // bodies below line up; a rename/reorder is itself a contract break.
    expect(inArgNames(FN_RSVP), "submit_rsvp gained wechat_id as the LAST arg").toEqual([
      "slug",
      "display_name",
      "status",
      "guest_token",
      "plus_ones",
      "contact",
      "client_fingerprint",
      "wechat_id",
    ]);
    expect(inArgNames(FN_LOCK), "lock_event(event_id)").toEqual(["event_id"]);
    expect(inArgNames(FN_CONTACTS), "get_event_guest_contacts(event_id)").toEqual(["event_id"]);
    expect(inArgNames(FN_SLUG), "get_event_by_slug keeps its 5-arg signature").toEqual([
      "slug",
      "guest_token",
      "password",
      "password_verified",
      "viewer_id",
    ]);

    // Idempotent reset.
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);

    // Host profiles carry the host wechat sentinel (single source of truth = profile).
    runSql(
      `insert into public.profiles (id, display_name, wechat_id) values
         ('${hostA.id}', 'r4wx host A', '${HOST_WX}')
       on conflict (id) do update set wechat_id = excluded.wechat_id, display_name = excluded.display_name;`,
    );
    // Host B has NO wechat — it is the non-host attacker.
    runSql(
      `insert into public.profiles (id, display_name) values ('${hostB.id}', 'r4wx host B')
         on conflict (id) do nothing;`,
    );

    // Events. starts_at / ends_at / locked_at chosen to drive the lock + burn gates.
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, rsvp_enabled, date_tbd, starts_at, ends_at, locked_at) values
         ('${hostA.id}','${E_UNLOCKED}',  'r4wx unlocked',  'public','published', true, false, now() + interval '10 days', null, null),
         ('${hostA.id}','${E_LOCKED}',    'r4wx locked',    'public','published', true, false, now() + interval '10 days', null, now()),
         ('${hostA.id}','${E_AUTO_IN}',   'r4wx auto in',   'public','published', true, false, now() + interval '12 hours', null, null),
         ('${hostA.id}','${E_AUTO_OUT}',  'r4wx auto out',  'public','published', true, false, now() + interval '3 days',  null, null),
         ('${hostA.id}','${E_TBD}',       'r4wx tbd',       'public','published', true, true,  null, null, null),
         ('${hostA.id}','${E_BURNED}',    'r4wx burned',    'public','published', true, false, now() - interval '3 days', now() - interval '2 days', now() - interval '4 days'),
         ('${hostA.id}','${E_FRESH_END}', 'r4wx freshend',  'public','published', true, false, now() - interval '2 days', now() - interval '1 hour', now() - interval '3 days'),
         ('${hostA.id}','${E_GATE}',      'r4wx gate',      'public','published', true, false, now() + interval '10 days', null, null),
         ('${hostA.id}','${E_LOCK_GATE}', 'r4wx lockgate',  'public','published', true, false, now() + interval '10 days', null, now()),
         ('${hostA.id}','${E_AUTHZ}',     'r4wx authz',     'public','published', true, false, now() + interval '10 days', null, null),
         ('${hostA.id}','${E_COLHARD}',   'r4wx colhard',   'public','published', true, false, now() + interval '10 days', null, null);`,
    );

    // A deterministic RSVP'd-going guest WITH a wechat, on every event where the
    // unlocked-viewer reveal / host-contacts view is exercised. The token unlocks
    // the viewer; the wechat is what the host's contacts RPC must surface (only on lock).
    const revealEvents = [E_UNLOCKED, E_LOCKED, E_AUTO_IN, E_AUTO_OUT, E_BURNED, E_FRESH_END, E_TBD];
    for (const [idx, slug] of revealEvents.entries()) {
      const tok = `4f000000-0000-4000-8000-0000000000${(idx + 10).toString().padStart(2, "0")}`;
      runSql(
        `insert into public.guests (event_id, guest_token, display_name, wechat_id)
           values ((select id from public.events where slug='${slug}'), '${tok}'::uuid, 'r4wx attendee', '${GUEST_WX}');
         insert into public.rsvps (event_id, guest_id, status)
           select g.event_id, g.id, 'going' from public.guests g where g.guest_token='${tok}'::uuid;`,
      );
      // E_LOCKED uses the well-known T_RSVP token so probes below are explicit.
      if (slug === E_LOCKED) {
        runSql(`update public.guests set guest_token='${T_RSVP}'::uuid where guest_token='${tok}'::uuid;`);
      }
    }
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    // Don't strip the host wechat back off — other suites seed their own profiles.
  });

  // Convenience: the token now living on E_LOCKED's RSVP'd attendee.
  function lockedToken(): string {
    return T_RSVP;
  }
  function tokenFor(slug: string): string {
    return scalar(
      runSql(`select guest_token from public.guests g
                join public.events e on e.id=g.event_id
               where e.slug='${slug}' and g.display_name='r4wx attendee' limit 1;`),
    );
  }

  // ── [A1] No pre-lock leak — host wechat hidden even from an RSVP'd/unlocked viewer ─
  it.skipIf(!LOCAL_UP)(
    "[A1] unlocked event: host_wechat_id is NEVER returned — anon, RSVP'd-token viewer, or service",
    async () => {
      const tok = tokenFor(E_UNLOCKED);

      // anon passerby — no host wechat, no guest wechat anywhere.
      const an = await readSlug(anon(), E_UNLOCKED);
      expect(an.res.error, JSON.stringify(an.res.error)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(an.data ?? {}, "host_wechat_id"),
        "pre-lock anon ⇒ NO host_wechat_id key").toBe(false);
      expect(JSON.stringify(an.data), "no host wechat sentinel pre-lock").not.toContain(HOST_WX);
      expect(JSON.stringify(an.data), "no guest wechat sentinel ever in the slug payload").not.toContain(GUEST_WX);

      // The viewer who HAS RSVP'd (valid token ⇒ unlocked) STILL gets no host wechat
      // pre-lock — double-blind: unlock is necessary but not sufficient, lock is too.
      const unlocked = await readSlug(service(), E_UNLOCKED, { token: tok });
      expect(unlocked.data?.unlocked, "valid token unlocks the address tier").toBe(true);
      expect(Object.prototype.hasOwnProperty.call(unlocked.data ?? {}, "host_wechat_id"),
        "RSVP'd-but-not-locked viewer ⇒ STILL no host_wechat_id (double-blind)").toBe(false);
      expect(JSON.stringify(unlocked.data), "no host wechat even when unlocked, pre-lock").not.toContain(HOST_WX);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A1] unlocked event: get_event_guest_contacts returns [] even to the host (lock gate, not just authz)",
    async () => {
      const c = await readContacts(asHost(hostA.accessToken), eventId(E_UNLOCKED));
      expect(c.res.error, JSON.stringify(c.res.error)).toBeNull();
      expect(c.rows, "host gets [] pre-lock — guest wechat is locked-only").toEqual([]);
    },
  );

  // ── [A2] is_locked always present on the normal payload, false pre-lock ───────────
  it.skipIf(!LOCAL_UP)(
    "[A2] is_locked is ALWAYS present on the normal get_event_by_slug payload and is false pre-lock",
    async () => {
      const r = await readSlug(anon(), E_UNLOCKED);
      expect(Object.prototype.hasOwnProperty.call(r.data ?? {}, "is_locked"),
        "is_locked key is always present on the tiered façade").toBe(true);
      expect(r.data?.is_locked, "an unlocked event reports is_locked=false").toBe(false);
    },
  );

  // ── [A3] Manual lock reveals two-way and ONLY to the right parties ────────────────
  it.skipIf(!LOCAL_UP)(
    "[A3] locked event: an RSVP'd/unlocked viewer gets host_wechat_id; a non-RSVP'd passerby does NOT",
    async () => {
      // RSVP'd viewer (valid token ⇒ unlocked) on a LOCKED event ⇒ host wechat revealed.
      const unlocked = await readSlug(service(), E_LOCKED, { token: lockedToken() });
      expect(unlocked.data?.unlocked, "token unlocks").toBe(true);
      expect(unlocked.data?.is_locked, "manually-locked ⇒ is_locked=true").toBe(true);
      expect(unlocked.data?.host_wechat_id, "locked + unlocked ⇒ host wechat revealed").toBe(HOST_WX);

      // A passerby (no token, not unlocked) on the SAME locked event ⇒ still nothing.
      const passerby = await readSlug(anon(), E_LOCKED);
      expect(passerby.data?.is_locked, "passerby still sees is_locked=true").toBe(true);
      expect(passerby.data?.unlocked, "passerby is not unlocked").toBe(false);
      expect(Object.prototype.hasOwnProperty.call(passerby.data ?? {}, "host_wechat_id"),
        "a non-RSVP'd passerby NEVER gets host_wechat_id, even once locked").toBe(false);
      expect(JSON.stringify(passerby.data), "no host wechat to a passerby").not.toContain(HOST_WX);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A3] locked event: the HOST's get_event_guest_contacts returns attending guests WITH wechat; a non-host/anon gets []",
    async () => {
      const id = eventId(E_LOCKED);

      // The host sees the attending guest's wechat (the ONLY place guest wechat surfaces).
      const host = await readContacts(asHost(hostA.accessToken), id);
      expect(host.res.error, JSON.stringify(host.res.error)).toBeNull();
      expect(host.rows.length, "host sees the going attendee").toBeGreaterThan(0);
      expect(host.rows.some((r) => r.wechat_id === GUEST_WX),
        "the attending guest's wechat is returned to the host on lock").toBe(true);
      expect(host.rows.every((r) => typeof r.display_name === "string"),
        "each contact row carries display_name").toBe(true);

      // A DIFFERENT logged-in user (host B) ⇒ [] (host-only gate).
      const other = await readContacts(asHost(hostB.accessToken), id);
      expect(other.rows, "a non-host authed user gets [] (not someone else's contacts)").toEqual([]);

      // anon has NO grant on the RPC at all ⇒ the call errors / returns nothing useful.
      const an = (await anon().rpc(FN_CONTACTS, { event_id: id })) as ApiResult;
      const anRows = (an.data as ContactsRow[] | null) ?? [];
      expect(an.error !== null || anRows.length === 0,
        "anon can't read guest contacts (no execute grant)").toBe(true);
      expect(JSON.stringify(an.data), "no guest wechat leaks to anon").not.toContain(GUEST_WX);
    },
  );

  // ── [A4] lock_event authz + irreversibility + column-revoke denial ────────────────
  it.skipIf(!LOCAL_UP)(
    "[A4] lock_event is host-only: a non-host caller errors and locked_at stays NULL",
    async () => {
      expect(lockedAt(E_AUTHZ), "starts unlocked").toBe("");
      const id = eventId(E_AUTHZ);

      // Host B (not the host of E_AUTHZ) ⇒ 'not authorized', no write.
      const bad = (await asHost(hostB.accessToken).rpc(FN_LOCK, { event_id: id })) as ApiResult;
      expect(bad.error, "a non-host lock_event must error").not.toBeNull();
      expect(bad.error?.message ?? "", "specifically a not-authorized refusal").toMatch(/authoriz|not auth/i);
      expect(lockedAt(E_AUTHZ), "locked_at stays NULL after a refused lock").toBe("");

      // anon has no execute grant on lock_event ⇒ also denied, still NULL.
      const an = (await anon().rpc(FN_LOCK, { event_id: id })) as ApiResult;
      expect(an.error, "anon cannot lock (no execute grant)").not.toBeNull();
      expect(lockedAt(E_AUTHZ), "still NULL after anon attempt").toBe("");

      // A forged/unknown event_id ⇒ 'event not found', not a silent success.
      const ghost = (await asHost(hostA.accessToken)
        .rpc(FN_LOCK, { event_id: "00000000-0000-4000-8000-0000000000ff" })) as ApiResult;
      expect(ghost.error, "an unknown event_id ⇒ error (no row to lock)").not.toBeNull();
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A4] lock_event is irreversible + idempotent: the host locks once; a 2nd call leaves locked_at unchanged, no error",
    async () => {
      const id = eventId(E_AUTHZ);
      const first = (await asHost(hostA.accessToken).rpc(FN_LOCK, { event_id: id })) as ApiResult;
      expect(first.error, JSON.stringify(first.error)).toBeNull();
      const firstLocked = lockedAt(E_AUTHZ);
      expect(firstLocked, "the host's lock sets locked_at").not.toBe("");
      expect((first.data as Record<string, unknown> | null)?.is_locked, "returns is_locked=true").toBe(true);

      // A second lock_event must be idempotent — same locked_at, no error escalation.
      const second = (await asHost(hostA.accessToken).rpc(FN_LOCK, { event_id: id })) as ApiResult;
      expect(second.error, "a re-lock is idempotent, not an error").toBeNull();
      expect(lockedAt(E_AUTHZ), "locked_at is never moved by a 2nd lock (irreversible)").toBe(firstLocked);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A4/A9] a host's DIRECT PostgREST update of events.locked_at is DENIED (column revoke) — no clear/move side door",
    async () => {
      const before = lockedAt(E_AUTHZ); // locked above
      expect(before, "E_AUTHZ is locked").not.toBe("");

      // Try to CLEAR locked_at as the authenticated host via PostgREST — must fail.
      const id = eventId(E_AUTHZ);
      const clear = await asHost(hostA.accessToken)
        .from("events").update({ locked_at: null }).eq("id", id);
      // Either a hard error, or (if PostgREST silently no-ops the revoked column) the
      // value is unchanged. Both satisfy "cannot clear locked_at via PostgREST".
      const after = lockedAt(E_AUTHZ);
      expect(after, "locked_at must NOT be cleared by a direct authenticated update").toBe(before);
      // And the move-it variant is equally denied.
      const move = await asHost(hostA.accessToken)
        .from("events").update({ locked_at: "2000-01-01T00:00:00Z" }).eq("id", id);
      expect(lockedAt(E_AUTHZ), "locked_at must NOT be moved either").toBe(before);
      // At least one of the two attempts should also surface an error from the revoke.
      expect(clear.error !== null || move.error !== null || after === before,
        "the column revoke blocks the write (error or no-op)").toBe(true);
    },
  );

  // ── [A5] submit_rsvp gates: wechat required for going/maybe; rejected after lock ──
  it.skipIf(!LOCAL_UP)(
    "[A5] submit_rsvp: going/maybe WITHOUT a wechat is rejected; not_going may omit it; provided ⇒ stored",
    async () => {
      const an = anon();

      // going with no wechat ⇒ rejected.
      const goNo = (await an.rpc(FN_RSVP, {
        slug: E_GATE, display_name: "g-no", status: "going", client_fingerprint: "g-no",
      })) as ApiResult;
      expect(goNo.error, "going without wechat must be rejected").not.toBeNull();
      expect(goNo.error?.message ?? "", "the refusal is the wechat requirement").toMatch(/wechat/i);

      // maybe with blank/whitespace-only wechat ⇒ rejected (btrim/nullif gate).
      const maybeBlank = (await an.rpc(FN_RSVP, {
        slug: E_GATE, display_name: "m-blank", status: "maybe", wechat_id: "   ", client_fingerprint: "m-blank",
      })) as ApiResult;
      expect(maybeBlank.error, "maybe with a blank wechat is rejected (trimmed to null)").not.toBeNull();
      expect(maybeBlank.error?.message ?? "").toMatch(/wechat/i);

      // not_going may omit wechat entirely ⇒ accepted.
      const decline = (await an.rpc(FN_RSVP, {
        slug: E_GATE, display_name: "n-decline", status: "not_going", client_fingerprint: "n-decline",
      })) as ApiResult;
      expect(decline.error, "not_going carries no contact exchange ⇒ wechat optional").toBeNull();
      expect((decline.data as Record<string, unknown> | null)?.status).toBe("not_going");

      // going WITH a wechat ⇒ accepted and STORED (verified via the host contacts RPC
      // after we lock the event below).
      const goOk = (await an.rpc(FN_RSVP, {
        slug: E_GATE, display_name: "g-ok", status: "going", wechat_id: GUEST_WX, client_fingerprint: "g-ok",
      })) as ApiResult;
      expect(goOk.error, JSON.stringify(goOk.error)).toBeNull();

      // Lock E_GATE (host) and confirm the stored wechat surfaces to the host only.
      const id = eventId(E_GATE);
      await asHost(hostA.accessToken).rpc(FN_LOCK, { event_id: id });
      const contacts = await readContacts(asHost(hostA.accessToken), id);
      expect(contacts.rows.some((r) => r.display_name === "g-ok" && r.wechat_id === GUEST_WX),
        "the going guest's stored wechat is what the host sees on lock").toBe(true);
      // The not_going decliner is NOT in the host contacts view (only going/maybe/waitlisted).
      expect(contacts.rows.some((r) => r.display_name === "n-decline"),
        "a not_going decline is not an attending contact").toBe(false);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A5] submit_rsvp on a LOCKED event is rejected ('event is locked') — for a NEW guest and a RETURNING token-holder",
    async () => {
      const an = anon();

      // A brand-new guest on a locked event ⇒ refused (lock closes new RSVPs).
      const fresh = (await an.rpc(FN_RSVP, {
        slug: E_LOCK_GATE, display_name: "late", status: "going", wechat_id: GUEST_WX, client_fingerprint: "late",
      })) as ApiResult;
      expect(fresh.error, "a new RSVP on a locked event must be rejected").not.toBeNull();
      expect(fresh.error?.message ?? "", "the refusal is the lock gate").toMatch(/lock/i);

      // A returning guest (the well-known token, already RSVP'd before lock) ALSO
      // cannot edit once locked — the gate is on the event, not the guest's novelty.
      const ret = (await an.rpc(FN_RSVP, {
        slug: E_LOCKED, display_name: "edit-after-lock", status: "going",
        guest_token: lockedToken(), wechat_id: "changed-wx",
      })) as ApiResult;
      expect(ret.error, "even a returning token-holder is closed out once locked").not.toBeNull();
      expect(ret.error?.message ?? "").toMatch(/lock/i);
    },
  );

  // ── [A6] Auto-lock derivation via starts_at inside / outside 24h + date_tbd ───────
  it.skipIf(!LOCAL_UP)(
    "[A6] auto-lock: starts_at within 24h ⇒ is_locked=true (no manual lock) and contacts open to the RSVP'd guest",
    async () => {
      const r = await readSlug(anon(), E_AUTO_IN);
      expect(lockedAt(E_AUTO_IN), "no MANUAL lock — derivation only").toBe("");
      expect(r.data?.is_locked, "starts in 12h (<24h) ⇒ derived locked").toBe(true);

      // Contacts open to the RSVP'd, unlocked viewer purely from the time derivation.
      const tok = tokenFor(E_AUTO_IN);
      const unlocked = await readSlug(service(), E_AUTO_IN, { token: tok });
      expect(unlocked.data?.host_wechat_id, "auto-locked + unlocked ⇒ host wechat revealed").toBe(HOST_WX);

      // And the host's contacts RPC opens too.
      const contacts = await readContacts(asHost(hostA.accessToken), eventId(E_AUTO_IN));
      expect(contacts.rows.some((x) => x.wechat_id === GUEST_WX),
        "host sees guest wechat on an auto-locked event").toBe(true);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A6] auto-lock: starts_at >24h away ⇒ is_locked=false and NO wechat anywhere; date_tbd ⇒ false but lock_event still works",
    async () => {
      // >24h out ⇒ not locked, no reveal even to the RSVP'd viewer.
      const out = await readSlug(service(), E_AUTO_OUT, { token: tokenFor(E_AUTO_OUT) });
      expect(out.data?.is_locked, "starts in 3 days (>24h) ⇒ not auto-locked").toBe(false);
      expect(Object.prototype.hasOwnProperty.call(out.data ?? {}, "host_wechat_id"),
        ">24h out ⇒ no host wechat even to an RSVP'd viewer").toBe(false);
      expect((await readContacts(asHost(hostA.accessToken), eventId(E_AUTO_OUT))).rows,
        "host contacts closed on a not-yet-locked event").toEqual([]);

      // date_tbd (no dates) ⇒ auto-lock NEVER fires.
      const tbd = await readSlug(anon(), E_TBD);
      expect(tbd.data?.is_locked, "date_tbd (no starts_at) ⇒ is_locked=false").toBe(false);

      // …but a MANUAL lock_event still works on a date_tbd event.
      const id = eventId(E_TBD);
      const lk = (await asHost(hostA.accessToken).rpc(FN_LOCK, { event_id: id })) as ApiResult;
      expect(lk.error, JSON.stringify(lk.error)).toBeNull();
      expect((lk.data as Record<string, unknown> | null)?.is_locked, "manual lock works on date_tbd").toBe(true);
      const after = await readSlug(service(), E_TBD, { token: tokenFor(E_TBD) });
      expect(after.data?.is_locked, "date_tbd is locked after a manual lock").toBe(true);
      expect(after.data?.host_wechat_id, "and contacts open (no ends/starts ⇒ never burns)").toBe(HOST_WX);
    },
  );

  // ── [A7] 阅后即焚 burn: wechat gone >24h after effective end though is_locked stays true ─
  it.skipIf(!LOCAL_UP)(
    "[A7] a locked event ended >24h ago ⇒ NO host_wechat_id and host contacts=[], EVEN THOUGH is_locked stays true",
    async () => {
      // is_locked is sticky (manual lock never clears), but the burn window closed.
      const viewer = await readSlug(service(), E_BURNED, { token: tokenFor(E_BURNED) });
      expect(viewer.data?.is_locked, "the lock itself never expires — is_locked is still true").toBe(true);
      expect(viewer.data?.unlocked, "the viewer still has a valid token").toBe(true);
      expect(Object.prototype.hasOwnProperty.call(viewer.data ?? {}, "host_wechat_id"),
        "burned (>24h after end) ⇒ host wechat is gone again (阅后即焚)").toBe(false);
      expect(JSON.stringify(viewer.data), "no host wechat after the burn").not.toContain(HOST_WX);

      const contacts = await readContacts(asHost(hostA.accessToken), eventId(E_BURNED));
      expect(contacts.rows, "host contacts close after the burn window, even while locked").toEqual([]);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A7] a locked event ended <24h ago ⇒ wechat STILL revealed (the burn fires only past +24h)",
    async () => {
      const viewer = await readSlug(service(), E_FRESH_END, { token: tokenFor(E_FRESH_END) });
      expect(viewer.data?.is_locked).toBe(true);
      expect(viewer.data?.host_wechat_id, "within 24h of end ⇒ still revealed").toBe(HOST_WX);

      const contacts = await readContacts(asHost(hostA.accessToken), eventId(E_FRESH_END));
      expect(contacts.rows.some((x) => x.wechat_id === GUEST_WX),
        "host contacts still open within the burn window").toBe(true);
    },
  );

  // ── [A8] Guests never see each other's wechat (get_guest_list carries no wechat) ──
  it.skipIf(!LOCAL_UP)(
    "[A8] get_guest_list NEVER exposes wechat_id — locked OR unlocked, to an RSVP'd viewer",
    async () => {
      // On the LOCKED event, an unlocked (RSVP'd) viewer reads the roster. Even here —
      // where contacts ARE open two-way — guest↔guest wechat must NOT cross.
      const lockedList = (await service().rpc(FN_LIST, {
        slug: E_LOCKED, guest_token: lockedToken(),
      })) as ApiResult;
      const lrows = (lockedList.data as Array<Record<string, unknown>> | null) ?? [];
      expect(lockedList.error, JSON.stringify(lockedList.error)).toBeNull();
      for (const row of lrows) {
        expect(Object.prototype.hasOwnProperty.call(row, "wechat_id"),
          "no wechat_id key on any guest-list entry (locked)").toBe(false);
      }
      expect(JSON.stringify(lrows), "the guest wechat sentinel never rides the roster").not.toContain(GUEST_WX);

      // And on an unlocked event, same guarantee.
      const openList = (await service().rpc(FN_LIST, {
        slug: E_UNLOCKED, guest_token: tokenFor(E_UNLOCKED),
      })) as ApiResult;
      const orows = (openList.data as Array<Record<string, unknown>> | null) ?? [];
      for (const row of orows) {
        expect(Object.prototype.hasOwnProperty.call(row, "wechat_id"),
          "no wechat_id key on any guest-list entry (unlocked)").toBe(false);
      }
      expect(JSON.stringify(orows)).not.toContain(GUEST_WX);
    },
  );

  // ── [A9] Column hardening: authenticated can't select wechat / update locked_at ──
  //
  // Appendix A item 9 + 0021's §1.2 require that the role-level column REVOKEs leave
  // `authenticated` WITHOUT select(guests.wechat_id) and WITHOUT update(events.locked_at)
  // — the ONLY paths are the gated DEFINER RPCs. The authoritative DB check is
  // `has_column_privilege`, which reflects the effective privilege AFTER the revoke
  // (and is immune to RLS returning an empty set, which would mask a leak as "no rows").
  //
  // NOTE (independent-agent finding): a plain column REVOKE does NOT subtract from a
  // pre-existing TABLE-level GRANT. Migration 0004 granted `select on public.guests`
  // and `update on public.events` table-wide to `authenticated`, so these column
  // revokes are no-ops and the privilege is STILL held. These assertions therefore pin
  // the CONTRACT (the privilege must be gone); if they go red, the hardening is not
  // effective and the host can read guest wechat / move locked_at straight off the
  // table. See the returned manifest's "uncovered_or_concerns".
  it.skipIf(!LOCAL_UP)(
    "[A9] authenticated has NO select privilege on guests.wechat_id (column revoke must be effective)",
    () => {
      const priv = scalar(
        runSql(`select has_column_privilege('authenticated','public.guests','wechat_id','SELECT');`),
      );
      expect(priv, "authenticated.select(guests.wechat_id) must be revoked (the gated RPC is the only path)").toBe("f");
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A9] authenticated has NO update privilege on events.locked_at (lock is RPC-only + irreversible)",
    () => {
      const priv = scalar(
        runSql(`select has_column_privilege('authenticated','public.events','locked_at','UPDATE');`),
      );
      expect(priv, "authenticated.update(events.locked_at) must be revoked (only lock_event may write it)").toBe("f");
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A9] a host's DIRECT PostgREST select of guests.wechat_id must NOT yield the sentinel (only the gated RPC may)",
    async () => {
      const id = eventId(E_LOCKED);
      // The host CAN see their own event's guest rows via RLS (guests_select_by_host),
      // so if the column revoke is ineffective this projection returns the sentinel.
      const sel = await asHost(hostA.accessToken)
        .from("guests").select("wechat_id").eq("event_id", id);
      const leaked = JSON.stringify(sel.data ?? "");
      expect(
        sel.error !== null || !leaked.includes(GUEST_WX),
        "guest wechat must NOT come back on a direct authenticated table read",
      ).toBe(true);

      // A select of allowed columns still works (the revoke is column-scoped, not table-wide).
      const ok = await asHost(hostA.accessToken)
        .from("guests").select("display_name").eq("event_id", id);
      expect(ok.error, "selecting non-revoked columns still works").toBeNull();
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[A9] the DEFINER RPC is UNAFFECTED by the column revokes — it runs as the table owner",
    async () => {
      // The wechat-bearing READ path for the host is the DEFINER RPC, which runs as the
      // table owner and so is immune to any role-level column revoke (that's the design
      // — the revoke removes the DIRECT side door, the RPC remains the gated front door).
      // NB: with Supabase auto-expose OFF, service_role holds NO direct table grant on
      // guests either, so the RPC is the only contact path for every non-owner role.
      const contacts = await readContacts(asHost(hostA.accessToken), eventId(E_LOCKED));
      expect(contacts.rows.some((r) => r.wechat_id === GUEST_WX),
        "the DEFINER RPC still returns guest wechat on a locked event (owner privileges)").toBe(true);

      // The function is OWNED by a superuser/owner role, not SECURITY INVOKER, so the
      // revoke on `authenticated` cannot starve it.
      const isDefiner = scalar(
        runSql(`select prosecdef from pg_proc where proname='get_event_guest_contacts'
                  and pronamespace='public'::regnamespace limit 1;`),
      );
      expect(isDefiner, "get_event_guest_contacts is SECURITY DEFINER").toBe("t");
    },
  );

  // ── grants pinned: anon must NOT hold execute on the host-only RPCs ───────────────
  it.skipIf(!LOCAL_UP)(
    "[A3/A4] grant surface: lock_event + get_event_guest_contacts are NOT granted to anon",
    () => {
      const lockGrants = execGrantees(FN_LOCK, "event_id uuid");
      expect(lockGrants.has("anon"), "lock_event is NOT granted to anon").toBe(false);
      expect(lockGrants.has("authenticated"), "lock_event is granted to authenticated").toBe(true);

      const contactGrants = execGrantees(FN_CONTACTS, "event_id uuid");
      expect(contactGrants.has("anon"), "get_event_guest_contacts is NOT granted to anon").toBe(false);
      expect(contactGrants.has("authenticated"), "…but is granted to authenticated").toBe(true);
    },
  );
});
