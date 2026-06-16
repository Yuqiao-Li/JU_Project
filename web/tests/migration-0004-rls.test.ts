import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anonClient, hostClient, infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.3 [SECURITY] — RLS + policies + host-access grants (migration
 * 0004_rls_and_host_grants.sql; TEST-SPEC §1.3).
 *
 * Written by the INDEPENDENT test agent (never wrote the implementation), with a
 * "assume the migration is leaky" stance. Two layers are probed adversarially:
 *
 *   1. BEHAVIOURAL (PostgREST, the real attack surface) — anon / authenticated
 *      clients hit the Data API exactly as a browser or a forged client would:
 *        * anon has NO grant on client-data tables  -> must be DENIED (error),
 *          not merely RLS-filtered to empty (an accidental anon GRANT would leak
 *          past an empty-array check, so we assert error != null = G1).
 *        * a logged-in host sees ONLY its own event's rows (incl. contact);
 *          another host / anon sees ZERO — the host-ownership policies are keyed
 *          on events.host_id = auth.uid() (D9/M1).
 *   2. DB-AUTHORITATIVE (pg_catalog, via psql as the postgres superuser) — the
 *      grant/policy shape itself: anon has no SELECT/DML anywhere, authenticated
 *      is SELECT-only on child tables and full-CRUD only on events, rate_limits
 *      is denied to every client, every table keeps RLS + a non-permissive
 *      policy, and storage.objects stays RLS-on (deny baseline; buckets land in
 *      1.7). These catch a weakening the behavioural layer might mask.
 *
 * Seeding is done as the postgres superuser (psql), because — with Supabase
 * auto-expose OFF — even `service_role` has no API grant on these tables, so the
 * service client cannot INSERT via PostgREST. Same pattern as the 1.1/1.2 tests.
 *
 * Gated on a reachable local stack so the suite still skips (green) without
 * Docker; where the stack IS up, the isolation must really hold.
 */
const LOCAL_UP = localStackRunning();

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

/** Lines of a psql `-At` multi-row result (offender lists from the DB checks). */
function lines(out: string): string[] {
  return out.trim().split("\n").map((l) => l.trim()).filter(Boolean);
}

// A PostgREST response, structurally — { data, error } is all we assert on.
type ApiResult = { data: unknown; error: unknown };

/** Rows of a PostgREST response, or [] when denied / null. */
function rowsOf(res: ApiResult): Record<string, unknown>[] {
  return Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
}

/** True when the Data API refused the call outright (no grant => permission denied). */
function denied(res: ApiResult): boolean {
  return res.error != null;
}

// Sentinels — unique enough to prove a specific value never crosses a boundary.
const TITLE_PREFIX = "t13"; // cleanup deletes every event whose title starts here
const CONTACT_A = "ada.t13@sentinel.invalid"; // host A's guest contact (host-only, D1)
const CONTACT_B = "bob.t13@sentinel.invalid"; // host B's guest contact
const LOCATION_A = "t13-221B-secret-baker-street"; // full address — second class

// 🟡 tables: TABLE-ONLY in MVP, host-SELECT-only, anon/guest deny (D8).
const YELLOW_TABLES = [
  "comment_reactions",
  "event_photos",
  "questions",
  "answers",
  "scheduled_reminders",
  "broadcasts",
] as const;

// Dashboard-class tables anon must never reach directly (reads go via DEFINER RPC).
const DASHBOARD_TABLES = [
  "events",
  "guests",
  "rsvps",
  "comments",
  "date_options",
  "date_votes",
  "answers",
  "questions",
  "comment_reactions",
  "event_photos",
  "scheduled_reminders",
  "broadcasts",
  "event_hosts",
] as const;

describe("task 1.3 [SECURITY]: RLS host isolation + positive self-read + 🟡 deny + storage (TEST-SPEC §1.3)", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

  let eventA = ""; // owned by host A (public/published)
  let eventB = ""; // owned by host B (private/published)
  let guestA = ""; // host A's guest, carries CONTACT_A + a 'going' rsvp
  let commentId = ""; // guest-authored comment on event A (FK for reactions)
  let questionId = ""; // question on event A (FK for answers)

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);

    const aId = hostA?.id ?? "";
    const bId = hostB?.id ?? "";
    expect(aId).not.toBe("");
    expect(bId).not.toBe("");
    expect(aId).not.toBe(bId);

    // Profiles are auto-created by the auth.users trigger; upsert defensively so
    // the file is self-contained regardless of run order.
    runSql(
      `insert into public.profiles (id, display_name) values
         ('${aId}', 'Host A t13'), ('${bId}', 'Host B t13')
       on conflict (id) do nothing;`,
    );

    eventA = scalar(
      runSql(
        `with ins as (
           insert into public.events
             (host_id, title, visibility, status, location_text, location_city, capacity)
           values ('${aId}', '${TITLE_PREFIX} Event A', 'public', 'published',
                   '${LOCATION_A}', 'Metropolis', 50)
           returning id
         ) select id from ins;`,
      ),
    );
    eventB = scalar(
      runSql(
        `with ins as (
           insert into public.events (host_id, title, visibility, status, location_text)
           values ('${bId}', '${TITLE_PREFIX} Event B', 'private', 'published', 't13-B-secret-addr')
           returning id
         ) select id from ins;`,
      ),
    );

    guestA = scalar(
      runSql(
        `with ins as (
           insert into public.guests (event_id, display_name, contact)
           values ('${eventA}', 'Ada t13', '${CONTACT_A}') returning id
         ) select id from ins;`,
      ),
    );
    const guestNg = scalar(
      runSql(
        `with ins as (insert into public.guests (event_id, display_name) values ('${eventA}', 'NoShow t13') returning id) select id from ins;`,
      ),
    );
    const guestWl = scalar(
      runSql(
        `with ins as (insert into public.guests (event_id, display_name) values ('${eventA}', 'Wait t13') returning id) select id from ins;`,
      ),
    );
    // host B's guest carries CONTACT_B — used to prove it never leaks to host A.
    runSql(
      `insert into public.guests (event_id, display_name, contact)
       values ('${eventB}', 'Bob t13', '${CONTACT_B}');`,
    );

    // Three statuses on event A: a host dashboard read must see ALL of them
    // (going / not_going / waitlisted) — unlike the redacted guest-list RPC.
    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones) values
         ('${eventA}', '${guestA}', 'going', 2),
         ('${eventA}', '${guestNg}', 'not_going', 0),
         ('${eventA}', '${guestWl}', 'waitlisted', 0);`,
    );

    commentId = scalar(
      runSql(
        `with ins as (insert into public.comments (event_id, guest_id, body) values ('${eventA}', '${guestA}', 't13 hi') returning id) select id from ins;`,
      ),
    );
    questionId = scalar(
      runSql(
        `with ins as (insert into public.questions (event_id, prompt, type) values ('${eventA}', 't13 veg?', 'single') returning id) select id from ins;`,
      ),
    );
    runSql(
      `insert into public.answers (question_id, guest_id, value) values ('${questionId}', '${guestA}', '"t13-answer"'::jsonb);`,
    );
    runSql(
      `insert into public.comment_reactions (comment_id, guest_id, emoji) values ('${commentId}', '${guestA}', '🎉');`,
    );
    runSql(
      `insert into public.event_photos (event_id, guest_id, image_url) values ('${eventA}', '${guestA}', 'event-photos/t13.jpg');`,
    );
    runSql(
      `insert into public.scheduled_reminders (event_id, remind_at, channel) values ('${eventA}', timestamptz '2030-01-01 00:00:00+00', 'email');`,
    );
    runSql(
      `insert into public.broadcasts (event_id, body, channel) values ('${eventA}', 't13 blast', 'sms');`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    // Delete every t13 event (incl. the self-read probe created in-test); the
    // ON DELETE CASCADE FKs clear all the seeded children with it.
    runSql(`delete from public.events where title like '${TITLE_PREFIX}%';`);
  });

  // ── §1.3 bullet 1 — host A cannot READ host B's events/guests/rsvps ──────────
  it.skipIf(!LOCAL_UP)("host A cannot read host B's events / guests / rsvps (read isolation, D9)", async () => {
    const cA = hostClient(hostA);

    // own event readable; B's event invisible (grant present, RLS filters to []).
    expect(rowsOf(await cA.from("events").select("id").eq("id", eventA))).toHaveLength(1);
    expect(rowsOf(await cA.from("events").select("id").eq("id", eventB))).toHaveLength(0);

    // B's child rows invisible to A.
    expect(rowsOf(await cA.from("guests").select("*").eq("event_id", eventB))).toHaveLength(0);
    expect(rowsOf(await cA.from("rsvps").select("*").eq("event_id", eventB))).toHaveLength(0);

    // The crux: host B's contact must never surface through host A's session.
    expect(rowsOf(await cA.from("guests").select("contact").eq("contact", CONTACT_B))).toHaveLength(0);
  });

  // ── §1.3 bullet 2 — host A cannot UPDATE/DELETE host B's events ──────────────
  it.skipIf(!LOCAL_UP)("host A cannot UPDATE or DELETE host B's events (write isolation)", async () => {
    const cA = hostClient(hostA);

    // RLS USING(host_id = auth.uid()) matches 0 rows of B's -> nothing written.
    const upd = await cA.from("events").update({ title: "t13-HACKED-BY-A" }).eq("id", eventB).select();
    expect(rowsOf(upd)).toHaveLength(0);
    // Authoritative proof B is untouched.
    expect(scalar(runSql(`select title from public.events where id = '${eventB}';`))).toBe(
      `${TITLE_PREFIX} Event B`,
    );

    const del = await cA.from("events").delete().eq("id", eventB).select();
    expect(rowsOf(del)).toHaveLength(0);
    expect(scalar(runSql(`select count(*) from public.events where id = '${eventB}';`))).toBe("1");
  });

  // ── §1.3 bullet 3 — anon cannot read any dashboard-class table ───────────────
  it.skipIf(!LOCAL_UP)("anon is DENIED on every dashboard-class table (no grant, G1)", async () => {
    const an = anonClient();
    for (const t of DASHBOARD_TABLES) {
      const res = await an.from(t).select("*").limit(1);
      // Assert DENIED (error), not merely empty: an accidental anon SELECT grant
      // would return [] and sail past an emptiness check — error != null nails G1.
      expect(denied(res), `anon must be denied SELECT on ${t}, got ${JSON.stringify(res.data)}`).toBe(true);
      expect(rowsOf(res), `anon must read 0 rows of ${t}`).toHaveLength(0);
    }
  });

  // ── §1.3 bullet 4 — positive self-read (anti self-lock) + owner row (D9) ─────
  it.skipIf(!LOCAL_UP)("positive (D9): host inserts an event then reads it straight back; trigger wrote the owner row", async () => {
    const cA = hostClient(hostA);

    const ins = await cA
      .from("events")
      .insert({ host_id: hostA.id, title: `${TITLE_PREFIX}-probe self-read` })
      .select();
    expect(ins.error, JSON.stringify(ins.error)).toBeNull();
    const created = rowsOf(ins);
    expect(created).toHaveLength(1);
    const newId = created[0].id as string;

    // Not self-locked: the same session reads its own fresh row back.
    expect(rowsOf(await cA.from("events").select("id").eq("id", newId))).toHaveLength(1);

    // The AFTER INSERT trigger wrote exactly one owner row, readable by A
    // (event_hosts policy: user_id = auth.uid()).
    const eh = rowsOf(await cA.from("event_hosts").select("user_id, role").eq("event_id", newId));
    expect(eh).toHaveLength(1);
    expect(eh[0].role).toBe("owner");
    expect(eh[0].user_id).toBe(hostA.id);

    // Adversarial: a host may NOT create an event owned by someone else
    // (WITH CHECK host_id = auth.uid() must reject the spoof).
    const spoof = await cA.from("events").insert({ host_id: hostB.id, title: `${TITLE_PREFIX}-spoof` }).select();
    expect(denied(spoof), "WITH CHECK must reject host_id != auth.uid()").toBe(true);
    expect(scalar(runSql(`select count(*) from public.events where title = '${TITLE_PREFIX}-spoof';`))).toBe("0");
  });

  // ── §1.3 bullet 5 — positive M1: owner reads full own data; others get none ──
  it.skipIf(!LOCAL_UP)("positive (M1): owner host reads its event's guests incl. contact, ALL rsvp statuses, full location_text", async () => {
    const cA = hostClient(hostA);

    // Full guest list WITH contact (third-class to guests, but the owner sees it).
    const guests = rowsOf(await cA.from("guests").select("display_name, contact").eq("event_id", eventA));
    expect(guests.length).toBeGreaterThanOrEqual(3);
    expect(guests.some((g) => g.contact === CONTACT_A)).toBe(true);

    // Owner dashboard sees EVERY status — including not_going & waitlisted, which
    // the public get_guest_list RPC redacts (proves this is the raw, owner view).
    const statuses = rowsOf(await cA.from("rsvps").select("status").eq("event_id", eventA)).map((r) => r.status);
    expect(statuses).toEqual(expect.arrayContaining(["going", "not_going", "waitlisted"]));

    // Full address (location_text — second class) is visible to the owner.
    const ev = rowsOf(await cA.from("events").select("location_text").eq("id", eventA));
    expect(ev[0].location_text).toBe(LOCATION_A);

    // Non-owner host B: zero rows of A's guests/rsvps, and CONTACT_A never leaks.
    const cB = hostClient(hostB);
    expect(rowsOf(await cB.from("guests").select("*").eq("event_id", eventA))).toHaveLength(0);
    expect(rowsOf(await cB.from("rsvps").select("*").eq("event_id", eventA))).toHaveLength(0);
    expect(rowsOf(await cB.from("guests").select("contact").eq("contact", CONTACT_A))).toHaveLength(0);

    // anon: denied outright on guests (no grant).
    const an = anonClient();
    expect(denied(await an.from("guests").select("*").eq("event_id", eventA))).toBe(true);
  });

  // ── §1.3 bullet 6 — 🟡 tables: anon SELECT denied + anon write denied (D8) ───
  it.skipIf(!LOCAL_UP)("🟡 tables (D8): anon SELECT denied and anon INSERT denied — looped", async () => {
    const an = anonClient();

    // Valid-shaped payloads so the ONLY thing stopping the write is the missing
    // grant (proves the deny is authorization, not a constraint/validation 400).
    const insertBody: Record<string, Record<string, unknown>> = {
      comment_reactions: { comment_id: commentId, guest_id: guestA, emoji: "💥" },
      event_photos: { event_id: eventA, image_url: "event-photos/t13-probe.jpg" },
      questions: { event_id: eventA, prompt: "t13 probe", type: "text" },
      answers: { question_id: questionId, guest_id: guestA, value: { probe: true } },
      scheduled_reminders: { event_id: eventA, remind_at: "2030-02-02T00:00:00Z", channel: "email" },
      broadcasts: { event_id: eventA, body: "t13 probe", channel: "sms" },
    };

    for (const t of YELLOW_TABLES) {
      const sel = await an.from(t).select("*").limit(1);
      expect(denied(sel), `anon must be denied SELECT on ${t}`).toBe(true);

      const ins = await an.from(t).insert(insertBody[t]).select();
      expect(denied(ins), `anon must be denied INSERT on ${t}`).toBe(true);
    }

    // Belt-and-suspenders at the DB layer: nothing anon-attempted was written.
    expect(scalar(runSql(`select count(*) from public.event_photos where image_url = 'event-photos/t13-probe.jpg';`))).toBe("0");
    expect(scalar(runSql(`select count(*) from public.broadcasts where body = 't13 probe';`))).toBe("0");
  });

  // ── §1.3 bullet 7 — answers host-isolation (D8) ──────────────────────────────
  it.skipIf(!LOCAL_UP)("answers (D8): owner host reads its own answers; non-owner host & anon get nothing", async () => {
    const cA = hostClient(hostA);
    const own = rowsOf(await cA.from("answers").select("value").eq("question_id", questionId));
    expect(own).toHaveLength(1);

    const cB = hostClient(hostB);
    expect(rowsOf(await cB.from("answers").select("*").eq("question_id", questionId))).toHaveLength(0);

    const an = anonClient();
    expect(denied(await an.from("answers").select("*").eq("question_id", questionId))).toBe(true);
  });

  // ── §1.3 bullet 8 — Storage deny baseline (D16; buckets/policies land in 1.7) ─
  it.skipIf(!LOCAL_UP)("storage (D16): storage.objects RLS on; anon & non-owner upload denied; event-photos not publicly readable", async () => {
    // For 1.3 the storage invariant is the deny baseline: storage.objects RLS ON
    // with no permissive policy (RLS on + no policy = every non-owner refused).
    // The buckets + host-write/public-cover/private-photo policies are built in
    // 1.7 — so every §1.3 storage assertion is a DENY assertion (which also keeps
    // holding once 1.7 lands: anon never writes; the album is never public).
    expect(scalar(
      runSql(
        `select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname='objects';`,
      ),
    )).toBe("t");

    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

    // anon uploading a cover to someone else's event prefix -> denied.
    const anonUp = await anonClient().storage.from("event-covers").upload(`${eventB}/probe.png`, png);
    expect(anonUp.error, "anon storage write must be denied").not.toBeNull();

    // A logged-in NON-owner host uploading into host B's event prefix -> denied.
    const nonOwnerUp = await hostClient(hostA).storage.from("event-covers").upload(`${eventB}/probe.png`, png);
    expect(nonOwnerUp.error, "non-owner storage write must be denied").not.toBeNull();

    // The private album bucket is never publicly readable by anon.
    const anonDl = await anonClient().storage.from("event-photos").download(`${eventB}/x.jpg`);
    expect(anonDl.error, "event-photos must not be publicly readable").not.toBeNull();
  });

  // ── 更狠边界 (1): DB-authoritative GRANT shape ───────────────────────────────
  it.skipIf(!LOCAL_UP)("grants (DB-authoritative): anon has no SELECT/DML; authenticated is SELECT-only on child tables, full CRUD only on events; rate_limits denied to all", () => {
    // NOTE: only data privileges (SELECT/INSERT/UPDATE/DELETE) are in scope.
    // REFERENCES/TRIGGER/TRUNCATE are Supabase platform defaults unreachable via
    // the Data API and are not what task 1.3 controls.

    // anon: zero SELECT/INSERT/UPDATE/DELETE on every client-data table (G1).
    const anonLeak = lines(
      runSql(
        `select 'ANON:'||t||':'||p
           from unnest(array['events','guests','rsvps','comments','date_options','date_votes','answers','questions','comment_reactions','event_photos','scheduled_reminders','broadcasts','rate_limits','event_hosts','profiles']) t,
                unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
          where has_table_privilege('anon','public.'||t, p);`,
      ),
    );
    expect(anonLeak, "anon must hold NO data privilege on any client-data table").toEqual([]);

    // authenticated: NO write on child / 🟡 tables (SELECT-only; writes are RPC-only).
    const overGrant = lines(
      runSql(
        `select 'AUTHN:'||t||':'||p
           from unnest(array['guests','rsvps','comments','date_options','date_votes','answers','questions','comment_reactions','event_photos','scheduled_reminders','broadcasts','event_hosts']) t,
                unnest(array['INSERT','UPDATE','DELETE']) p
          where has_table_privilege('authenticated','public.'||t, p);`,
      ),
    );
    expect(overGrant, "authenticated must be SELECT-only on child/🟡 tables").toEqual([]);

    // authenticated: MUST hold SELECT on each host-readable table (else the host
    // dashboard policy is inert — the very bug 1.3's grants exist to fix).
    const missingSelect = lines(
      runSql(
        `select 'MISS:'||t
           from unnest(array['events','guests','rsvps','comments','date_options','date_votes','answers','questions','comment_reactions','event_photos','scheduled_reminders','broadcasts','event_hosts','profiles']) t
          where not has_table_privilege('authenticated','public.'||t,'SELECT');`,
      ),
    );
    expect(missingSelect, "authenticated must hold SELECT on every host-readable table").toEqual([]);

    // events: the one entity a host writes directly — full CRUD for authenticated.
    const eventsMissing = lines(
      runSql(
        `select 'EVT:'||p from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
          where not has_table_privilege('authenticated','public.events', p);`,
      ),
    );
    expect(eventsMissing, "authenticated needs full CRUD on events").toEqual([]);

    // rate_limits: depth limiter — denied to anon AND authenticated (DEFINER-only, M3).
    const rlLeak = lines(
      runSql(
        `select r||':'||p from unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
          where has_table_privilege(r,'public.rate_limits', p);`,
      ),
    );
    expect(rlLeak, "rate_limits must be unreachable by any client role").toEqual([]);

    // profiles: self-managed -> SELECT+UPDATE, but never INSERT (trigger) / DELETE (account).
    expect(scalar(runSql(`select has_table_privilege('authenticated','public.profiles','INSERT');`))).toBe("f");
    expect(scalar(runSql(`select has_table_privilege('authenticated','public.profiles','DELETE');`))).toBe("f");
    expect(scalar(runSql(`select has_table_privilege('authenticated','public.profiles','UPDATE');`))).toBe("t");
  });

  // ── 更狠边界 (2): DB-authoritative RLS invariants (mirrors 护栏 5, as a test) ─
  it.skipIf(!LOCAL_UP)("RLS invariants (DB-authoritative): every public table RLS+policy; no using(true)/check(true); no anon/public policy on client tables; storage RLS on", () => {
    const clientTables =
      "'events','guests','rsvps','comments','date_votes','date_options','answers','questions','comment_reactions','event_photos','scheduled_reminders','broadcasts','rate_limits'";

    const offenders = lines(
      runSql(
        `select 'NO_RLS:'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
         union all
         select 'NO_POLICY:'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='r' and c.relrowsecurity
              and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname)
         union all
         select 'PERMISSIVE_TRUE:'||tablename||'.'||policyname from pg_policies
            where schemaname='public' and (coalesce(qual,'')='true' or coalesce(with_check,'')='true')
         union all
         select 'ANON_POLICY:'||tablename||'.'||policyname from pg_policies
            where schemaname='public' and tablename in (${clientTables}) and (roles && array['anon','public']::name[])
         union all
         select 'STORAGE_RLS_OFF' from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='storage' and c.relname='objects' and not c.relrowsecurity;`,
      ),
    );
    expect(offenders, "no RLS/policy/permissive/anon-policy/storage violations").toEqual([]);

    // rate_limits' single policy must be the explicit deny-all (using=false, check=false, M3).
    const rlPolicy = scalar(
      runSql(
        `select coalesce(qual,'?')||'/'||coalesce(with_check,'?') from pg_policies where schemaname='public' and tablename='rate_limits';`,
      ),
    );
    expect(rlPolicy).toBe("false/false");
  });
});
