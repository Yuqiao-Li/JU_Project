import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anonClient, infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.4 [SECURITY] — anon read/write convergence (migration
 * 0005_anon_revoke.sql, logical "0004"; TEST-SPEC §1.4).
 *
 * Written by the INDEPENDENT test agent (never wrote the implementation) with a
 * "assume the REVOKE missed something" stance. The single invariant under test:
 * the `anon` role can reach NO client-data table directly — every guest read and
 * write must flow through a SECURITY DEFINER RPC (1.5*), so anon's own table
 * privileges must be EMPTY. Three independent layers are probed:
 *
 *   1. BEHAVIOURAL via PostgREST (the real browser/forged-client attack surface):
 *      anon hitting the Data API on a *public + published* event must still be
 *      DENIED (error), not RLS-filtered to []. The public-event case is the crux
 *      of §1.4: even a publicly-viewable event is unreadable directly — it is the
 *      RPC, not "the row is private", that gates the read. An accidental anon
 *      SELECT grant would return [] and sail past an emptiness check, so we assert
 *      `error != null` (= G1), never just length 0.
 *   2. BEHAVIOURAL via a role-switched SQL session (psql `set local role anon`):
 *      the RLS-BYPASSING capabilities the migration explicitly claims to close —
 *      TRUNCATE (not subject to RLS — a held grant would let anon wipe every
 *      host's data), plus INSERT and CREATE TRIGGER — must each raise permission
 *      denied. PostgREST can't express TRUNCATE, so this layer is the only way to
 *      actually fire the destructive path 0005 exists to kill.
 *   3. DB-AUTHORITATIVE via pg_catalog (psql as postgres): anon AND the PUBLIC
 *      pseudo-role hold ZERO privileges of ANY type (incl. TRUNCATE/REFERENCES/
 *      TRIGGER) on every client-data table — and a FUTURE table created by the
 *      migration role re-grants anon nothing (the "从不 GRANT (仅 anon)" half /
 *      ALTER DEFAULT PRIVILEGES part of 0005). NB: unlike the 1.3 grant test —
 *      which deliberately ignores TRUNCATE/REFERENCES/TRIGGER as platform
 *      defaults — 1.4 is PRECISELY the task that strips them, so 1.4 asserts them.
 *
 * Seeding is done as the postgres superuser (psql): with Supabase auto-expose OFF
 * even service_role has no API grant on these tables, so PostgREST can't INSERT.
 * Same pattern as the 1.1/1.2/1.3 suites.
 *
 * Gated on a reachable local stack so the file still skips (green) without Docker;
 * where the stack IS up, the convergence must really hold.
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

/**
 * Run SQL expecting it to FAIL (ON_ERROR_STOP makes psql exit non-zero on the
 * first error). Returns whether it errored + the stderr, so a deny can be
 * asserted positively (`errored === true`) instead of via a thrown test.
 */
function runSqlExpectError(sql: string): { errored: boolean; message: string } {
  const cfg = resolveLocalSupabase({ autoStart: false });
  if (!cfg) throw new Error("local supabase stack not reachable");
  try {
    execFileSync("psql", [cfg.dbUrl, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { errored: false, message: "" };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr != null ? err.stderr.toString() : "";
    return { errored: true, message: stderr || (err.message ?? "") };
  }
}

/** True if a function of this name exists in schema public (gates 1.5* bullets). */
function functionExists(name: string): boolean {
  return (
    scalar(
      runSql(
        `select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='${name}');`,
      ),
    ) === "t"
  );
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
const TITLE_PREFIX = "t14"; // cleanup deletes every event whose title starts here
const SLUG_PUB = "t14-public-published-evt"; // a PUBLIC + PUBLISHED event's slug
const CONTACT = "nemo.t14@sentinel.invalid"; // host-only guest contact (D1)
const LOCATION_TEXT = "t14-secret-full-address-42-wallaby-way"; // second class
const LOCATION_URL = "https://maps.t14.invalid/secret-pin"; // second class
const LOCATION_CITY = "Sydney"; // first class (city-level)

// The §1.4-named client-data tables anon must never reach directly (reads/writes
// flow only through DEFINER RPCs). date_options/questions are added because they
// are equally client-data and give us valid FK targets for the write probes.
const BEHAVIOURAL_TABLES = [
  "events",
  "guests",
  "rsvps",
  "comments",
  "date_votes",
  "answers",
  "date_options",
  "questions",
] as const;

// The full set the migration REVOKEs from — used for the DB-authoritative sweep.
const CLIENT_TABLES = [
  "profiles",
  "events",
  "event_hosts",
  "guests",
  "rsvps",
  "comments",
  "comment_reactions",
  "event_photos",
  "date_options",
  "date_votes",
  "questions",
  "answers",
  "scheduled_reminders",
  "broadcasts",
  "rate_limits",
] as const;

// EVERY table privilege — including the three RLS-BYPASSING ones (TRUNCATE /
// REFERENCES / TRIGGER) that 0005 is specifically about. (MAINTAIN is PG17+ and
// not portable to has_table_privilege on older servers, so it is omitted.)
const ALL_TABLE_PRIVS = "'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'";

describe("task 1.4 [SECURITY]: anon read/write convergence + contact never reachable (TEST-SPEC §1.4)", () => {
  const i = infra();
  const hostA = i.hosts[0];

  let eventId = ""; // public + published, slug = SLUG_PUB
  let guestId = ""; // carries CONTACT (host-only)
  let optionId = ""; // date_options row (FK target for date_votes probe)
  let questionId = ""; // questions row (FK target for answers probe)

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);

    const aId = hostA?.id ?? "";
    expect(aId).not.toBe("");

    // Idempotent: clear any leftovers from a crashed prior run before re-seeding
    // (SLUG_PUB is UNIQUE, so a stale row would otherwise break the insert).
    runSql(`delete from public.events where title like '${TITLE_PREFIX}%' or slug like '${TITLE_PREFIX}%';`);

    // Profile is auto-created by the auth.users trigger; upsert defensively.
    runSql(
      `insert into public.profiles (id, display_name) values ('${aId}', 'Host A t14')
         on conflict (id) do nothing;`,
    );

    // A PUBLIC + PUBLISHED event with a known slug — the case §1.4 cares about
    // most: publicly viewable, yet anon must STILL not read it directly.
    eventId = scalar(
      runSql(
        `with ins as (
           insert into public.events
             (host_id, slug, title, visibility, status, location_text, location_url, location_city, capacity)
           values ('${aId}', '${SLUG_PUB}', '${TITLE_PREFIX} Public Event', 'public', 'published',
                   '${LOCATION_TEXT}', '${LOCATION_URL}', '${LOCATION_CITY}', 50)
           returning id
         ) select id from ins;`,
      ),
    );

    guestId = scalar(
      runSql(
        `with ins as (
           insert into public.guests (event_id, display_name, contact)
           values ('${eventId}', 'Nemo t14', '${CONTACT}') returning id
         ) select id from ins;`,
      ),
    );
    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
       values ('${eventId}', '${guestId}', 'going', 1);`,
    );
    runSql(
      `insert into public.comments (event_id, guest_id, body) values ('${eventId}', '${guestId}', 't14 hi');`,
    );
    optionId = scalar(
      runSql(
        `with ins as (insert into public.date_options (event_id, starts_at)
           values ('${eventId}', timestamptz '2030-03-03 18:00:00+00') returning id) select id from ins;`,
      ),
    );
    runSql(`insert into public.date_votes (date_option_id, guest_id) values ('${optionId}', '${guestId}');`);
    questionId = scalar(
      runSql(
        `with ins as (insert into public.questions (event_id, prompt, type)
           values ('${eventId}', 't14 veg?', 'single') returning id) select id from ins;`,
      ),
    );
    runSql(
      `insert into public.answers (question_id, guest_id, value) values ('${questionId}', '${guestId}', '"t14-ans"'::jsonb);`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    // ON DELETE CASCADE clears every seeded child with the event.
    runSql(`delete from public.events where title like '${TITLE_PREFIX}%' or slug like '${TITLE_PREFIX}%';`);
  });

  // ── §1.4 bullet 1 — anon direct SELECT on a PUBLIC+PUBLISHED event is DENIED ──
  it.skipIf(!LOCAL_UP)(
    "anon direct `from('events').eq('slug', …)` on a PUBLIC+PUBLISHED event is DENIED, not just empty (G1)",
    async () => {
      const an = anonClient();

      // The crux: a publicly-viewable event is STILL unreadable directly. error
      // != null proves anon has no grant (an empty [] would mean an accidental
      // grant + RLS filter — the exact leak §1.4 forbids).
      const bySlug = await an.from("events").select("*").eq("slug", SLUG_PUB);
      expect(denied(bySlug), `anon must be DENIED on events, got data=${JSON.stringify(bySlug.data)}`).toBe(true);
      expect(rowsOf(bySlug)).toHaveLength(0);

      // Same for an unfiltered scan and an explicit "only published public" filter
      // a forged client would try — every shape is denied at the grant layer.
      expect(denied(await an.from("events").select("*"))).toBe(true);
      expect(
        denied(await an.from("events").select("*").eq("visibility", "public").eq("status", "published")),
      ).toBe(true);
    },
  );

  // ── §1.4 bullet 2 — anon direct SELECT on every client-data table is DENIED ───
  it.skipIf(!LOCAL_UP)("anon direct SELECT on guests/rsvps/comments/date_votes/answers (+date_options/questions) is DENIED", async () => {
    const an = anonClient();
    for (const t of BEHAVIOURAL_TABLES) {
      const res = await an.from(t).select("*").limit(1);
      expect(denied(res), `anon must be DENIED SELECT on ${t}, got data=${JSON.stringify(res.data)}`).toBe(true);
      expect(rowsOf(res), `anon must read 0 rows of ${t}`).toHaveLength(0);
    }
  });

  // ── §1.4 bullet 3 — anon direct INSERT/UPDATE/DELETE is DENIED (writes via RPC) ─
  it.skipIf(!LOCAL_UP)("anon direct INSERT / UPDATE / DELETE on every client-data table is DENIED; nothing is written", async () => {
    const an = anonClient();

    // Valid-shaped payloads so the ONLY thing stopping the write is the missing
    // grant (proves the deny is authorization, not a constraint/validation 400).
    const insertBody: Record<string, Record<string, unknown>> = {
      events: { host_id: hostA.id, title: "t14-anon-insert" },
      guests: { event_id: eventId, display_name: "t14-anon-insert" },
      rsvps: { event_id: eventId, guest_id: guestId, status: "going" },
      comments: { event_id: eventId, body: "t14-anon-insert" },
      date_votes: { date_option_id: optionId, guest_id: guestId },
      answers: { question_id: questionId, guest_id: guestId, value: { hacked: true } },
      date_options: { event_id: eventId, starts_at: "2031-01-01T00:00:00Z" },
      questions: { event_id: eventId, prompt: "t14-anon-insert", type: "text" },
    };

    // Per-table filter on a column that genuinely EXISTS on that table, scoped to
    // a real seeded row — so the UPDATE/DELETE are well-formed and a hypothetical
    // anon grant would yield [] (RLS-filtered), not a "column not found" 400. That
    // makes each deny unambiguously an AUTHORIZATION deny, the §1.4 invariant.
    const target: Record<string, [string, string]> = {
      events: ["id", eventId],
      guests: ["event_id", eventId],
      rsvps: ["event_id", eventId],
      comments: ["event_id", eventId],
      date_votes: ["date_option_id", optionId],
      answers: ["question_id", questionId],
      date_options: ["event_id", eventId],
      questions: ["event_id", eventId],
    };

    for (const t of BEHAVIOURAL_TABLES) {
      const ins = await an.from(t).insert(insertBody[t]).select();
      expect(denied(ins), `anon must be DENIED INSERT on ${t}`).toBe(true);

      const [col, val] = target[t];
      // created_at exists on every one of these tables — valid update body.
      const upd = await an.from(t).update({ created_at: "2030-01-01T00:00:00Z" }).eq(col, val).select();
      expect(denied(upd), `anon must be DENIED UPDATE on ${t}`).toBe(true);
      const del = await an.from(t).delete().eq(col, val).select();
      expect(denied(del), `anon must be DENIED DELETE on ${t}`).toBe(true);
    }

    // Belt-and-suspenders at the DB layer: not one anon write landed, and the
    // event the UPDATEs/DELETEs targeted is still present and untouched.
    expect(scalar(runSql(`select count(*) from public.guests where display_name = 't14-anon-insert';`))).toBe("0");
    expect(scalar(runSql(`select count(*) from public.comments where body = 't14-anon-insert';`))).toBe("0");
    expect(scalar(runSql(`select count(*) from public.events where title = 't14-anon-insert';`))).toBe("0");
    expect(scalar(runSql(`select count(*) from public.events where id = '${eventId}';`))).toBe("1");
  });

  // ── §1.4 bullet 5 — contact is never reachable by anon (D1/G1) ───────────────
  it.skipIf(!LOCAL_UP)("contact never leaks: anon has NO path to guests at all, so the host-only contact is unreachable", async () => {
    const an = anonClient();

    // Direct table access is denied (no grant) — so there is no anon path that
    // could even project `contact`. Probe the column explicitly to be sure a
    // narrowed projection isn't somehow special-cased.
    expect(denied(await an.from("guests").select("*").eq("event_id", eventId))).toBe(true);
    expect(denied(await an.from("guests").select("contact").eq("contact", CONTACT))).toBe(true);
    expect(denied(await an.from("guests").select("display_name, contact"))).toBe(true);

    // And nothing anon got back carries the sentinel contact (denied => [] rows).
    expect(rowsOf(await an.from("guests").select("contact").eq("contact", CONTACT))).toHaveLength(0);
  });

  // ── §1.4 bullet 4 — anon via get_event_by_slug reads FIRST-CLASS only ────────
  // get_event_by_slug is built in task 1.5a (0005b); until then there is no anon
  // read path at all, which is itself the §1.4 guarantee. Gated on the function
  // existing so this lights up the moment 1.5a lands, asserting the RPC — anon's
  // ONLY read path — never returns the second-class address fields.
  it.skipIf(!LOCAL_UP || !functionExists("get_event_by_slug"))(
    "anon via get_event_by_slug on the public event returns first-class fields but NOT location_text/location_url",
    async () => {
      const an = anonClient();
      // Resolve the first arg name so the call survives the implementer's chosen
      // parameter spelling (slug | p_slug | …); slug is the first param per SCHEMA.
      const slugArg = scalar(
        runSql(
          `select (proargnames)[1] from pg_proc
             where proname='get_event_by_slug' and pronamespace='public'::regnamespace limit 1;`,
        ),
      );
      const res = await an.rpc("get_event_by_slug", { [slugArg]: SLUG_PUB });
      expect(res.error, JSON.stringify(res.error)).toBeNull();

      const obj = (Array.isArray(res.data) ? res.data[0] : res.data) as Record<string, unknown> | null;
      expect(obj, "public+published event must be readable via the RPC").not.toBeNull();
      // First class present…
      expect(obj?.title).toBe(`${TITLE_PREFIX} Public Event`);
      // …second class ABSENT (key omitted, not just null) — unlocked address only.
      expect(Object.prototype.hasOwnProperty.call(obj, "location_text")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(obj, "location_url")).toBe(false);
      // And contact never appears in any anon-reachable projection.
      expect(JSON.stringify(obj)).not.toContain(CONTACT);
    },
  );

  // ── 更狠边界 (1): DB-authoritative — anon & PUBLIC hold ZERO privileges ───────
  it.skipIf(!LOCAL_UP)(
    "grants (DB-authoritative): anon AND the PUBLIC pseudo-role hold NO privilege of ANY type (incl TRUNCATE/REFERENCES/TRIGGER) on any client-data table",
    () => {
      const tableArr = CLIENT_TABLES.map((t) => `'${t}'`).join(",");

      // anon: not one of SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
      // on any client-data table. The three RLS-BYPASSING privs are the whole
      // point of 0005 — a held TRUNCATE on events would let anon wipe every host.
      const anonLeak = lines(
        runSql(
          `select 'ANON:'||t||':'||p
             from unnest(array[${tableArr}]) t, unnest(array[${ALL_TABLE_PRIVS}]) p
            where has_table_privilege('anon','public.'||t, p);`,
        ),
      );
      expect(anonLeak, "anon must hold NO table privilege of any kind on client-data tables").toEqual([]);

      // PUBLIC pseudo-role: the vector by which a future blanket `grant … to
      // public` would reach anon. 0005 revokes from PUBLIC too — assert empty.
      const publicLeak = lines(
        runSql(
          `select 'PUBLIC:'||table_name||':'||privilege_type
             from information_schema.table_privileges
            where table_schema='public' and grantee='PUBLIC' and table_name in (${tableArr});`,
        ),
      );
      expect(publicLeak, "PUBLIC must hold no privilege on client-data tables (the anon back-door)").toEqual([]);

      // Sanity: the host path is NOT collateral damage — authenticated keeps
      // SELECT on events (the M1 dashboard self-read 0004 set up). 1.4 is
      // anon-only; weakening the host path would be a regression.
      expect(scalar(runSql(`select has_table_privilege('authenticated','public.events','SELECT');`))).toBe("t");
    },
  );

  // ── 更狠边界 (2): behavioural RLS-BYPASS — anon-role SQL session is refused ───
  it.skipIf(!LOCAL_UP)(
    "RLS-bypass (behavioural): a role-switched anon session is REFUSED TRUNCATE / INSERT / CREATE TRIGGER on events",
    () => {
      // TRUNCATE is NOT subject to RLS: if anon held the grant this would succeed
      // and destroy every host's data regardless of policy. It must raise.
      const trunc = runSqlExpectError(`begin; set local role anon; truncate public.events; rollback;`);
      expect(trunc.errored, "anon TRUNCATE must be denied").toBe(true);
      expect(trunc.message).toMatch(/permission denied/i);

      // INSERT via raw SQL (bypasses PostgREST entirely) — still denied at grant level.
      const ins = runSqlExpectError(
        `begin; set local role anon; insert into public.events(host_id,title) values (gen_random_uuid(),'t14-evil'); rollback;`,
      );
      expect(ins.errored, "anon INSERT (raw SQL) must be denied").toBe(true);
      expect(ins.message).toMatch(/permission denied/i);

      // TRIGGER: a held grant would let anon attach arbitrary triggers. Denied.
      const trig = runSqlExpectError(
        `begin; set local role anon; create trigger t14_evil before insert on public.events for each row execute function public.set_updated_at(); rollback;`,
      );
      expect(trig.errored, "anon CREATE TRIGGER must be denied").toBe(true);
      expect(trig.message).toMatch(/permission denied/i);

      // The event survived all three attempts (rollback + deny = untouched).
      expect(scalar(runSql(`select count(*) from public.events where id = '${eventId}';`))).toBe("1");
    },
  );

  // ── 更狠边界 (3): FUTURE-table convergence — ALTER DEFAULT PRIVILEGES half ────
  it.skipIf(!LOCAL_UP)(
    "future tables (DB-authoritative): a table newly created by the migration role grants anon NOTHING (0005 part 2)",
    () => {
      // Part 1 of 0005 (REVOKE on existing tables) is covered above. Part 2 must
      // also hold: a brand-new public table created by the migration role must
      // not re-open the inherited anon=Dxtm default grant. Create one, assert
      // anon has zero privileges on it, then drop it.
      runSql(`create table public.t14_future_default_probe (id int);`);
      try {
        const leak = lines(
          runSql(
            `select 'F:'||p from unnest(array[${ALL_TABLE_PRIVS}]) p
              where has_table_privilege('anon','public.t14_future_default_probe', p);`,
          ),
        );
        expect(leak, "a future table must grant anon no privilege (default-privs revoked for the migration role)").toEqual([]);
      } finally {
        runSql(`drop table if exists public.t14_future_default_probe;`);
      }
    },
  );
});
