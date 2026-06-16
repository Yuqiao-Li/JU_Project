import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { infra, serviceClient } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.1b — core tables B migration (0002: event_hosts + guests + rsvps +
 * triggers).
 *
 * Like 1.1a, this migration only ships DDL + triggers; RLS host-ownership GRANTs
 * (what actually exposes the tables to authenticated/service_role via PostgREST)
 * land in 1.3/1.4. So — exactly as in migration-0001a.test.ts — these assertions
 * hit the DB directly as the `postgres` superuser (bypassing grants/RLS), which
 * is what 1.1b's acceptance is about: "SQL 有效;触发器生效;集成:建 event 自动有
 * owner 行 + 注册自动建 profiles".
 *
 * Gated on a reachable local stack so the suite still skips (green) without
 * Docker; where the stack IS up, the schema/triggers must really be there.
 */
const LOCAL_UP = localStackRunning();

/** Run SQL as the postgres superuser. Throws (non-zero exit) on any SQL error. */
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

function jsonRow(out: string): Record<string, unknown> {
  return JSON.parse(scalar(out) || "{}");
}

// Every column from SCHEMA §3 (event_hosts), §4 (guests — incl. user_id), and §5
// (rsvps). Deterministic acceptance against the SCHEMA column list.
const EXPECTED_EVENT_HOSTS_COLUMNS = ["id", "event_id", "user_id", "role", "created_at"];
const EXPECTED_GUESTS_COLUMNS = [
  "id", "event_id", "guest_token", "user_id", "display_name", "contact", "created_at",
];
const EXPECTED_RSVPS_COLUMNS = [
  "id", "event_id", "guest_id", "status", "plus_ones", "approval_status",
  "created_at", "updated_at",
];

const YEAR_2000_EPOCH = 946684800; // 2000-01-01T00:00:00Z

describe("task 1.1b: core tables B migration (event_hosts + guests + rsvps + triggers)", () => {
  const i = infra();
  const hostId = i.hosts[0]?.id ?? "00000000-0000-0000-0000-000000000000";
  const otherHostId = i.hosts[1]?.id ?? "11111111-1111-1111-1111-111111111111";

  let eventId = "";
  let guestId = ""; // has an rsvp
  let guest2Id = ""; // no rsvp — used by constraint probes so unique(event,guest) never masks the constraint under test

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady).toBe(true);
    // host[0]/host[1] profiles are auto-created by the new auth.users trigger;
    // upsert defensively so the test is self-contained regardless of file order.
    runSql(
      `insert into public.profiles (id, display_name) values ('${hostId}', 'Host A 1.1b')
       on conflict (id) do nothing;`,
    );
    // Inserts are wrapped in a CTE selected back, so psql `-At` yields a single
    // value line with no `INSERT 0 1` command tag (same trick as 1.1a).
    eventId = scalar(
      runSql(
        `with ins as (insert into public.events (host_id, title) values ('${hostId}', '1.1b Event') returning id)
         select id from ins;`,
      ),
    );
    guestId = scalar(
      runSql(
        `with ins as (
           insert into public.guests (event_id, display_name, contact)
           values ('${eventId}', 'Ada', 'ada@example.com') returning id
         ) select id from ins;`,
      ),
    );
    guest2Id = scalar(
      runSql(
        `with ins as (
           insert into public.guests (event_id, display_name) values ('${eventId}', 'Bob') returning id
         ) select id from ins;`,
      ),
    );
    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
       values ('${eventId}', '${guestId}', 'going', 2);`,
    );
  });

  it.skipIf(!LOCAL_UP)("event_hosts/guests/rsvps carry every SCHEMA §3/§4/§5 column", () => {
    const eh = jsonRow(runSql(`select row_to_json(t) from public.event_hosts t where t.event_id = '${eventId}';`));
    for (const c of EXPECTED_EVENT_HOSTS_COLUMNS) expect(eh, `event_hosts.${c} must exist`).toHaveProperty(c);

    const g = jsonRow(runSql(`select row_to_json(t) from public.guests t where t.id = '${guestId}';`));
    for (const c of EXPECTED_GUESTS_COLUMNS) expect(g, `guests.${c} must exist`).toHaveProperty(c);
    // contact is host-only metadata (D1) but the column must exist here.
    expect(g.contact).toBe("ada@example.com");

    const r = jsonRow(runSql(`select row_to_json(t) from public.rsvps t where t.event_id = '${eventId}' and t.guest_id = '${guestId}';`));
    for (const c of EXPECTED_RSVPS_COLUMNS) expect(r, `rsvps.${c} must exist`).toHaveProperty(c);
    expect(r.status).toBe("going");
    expect(r.plus_ones).toBe(2);
  });

  it.skipIf(!LOCAL_UP)("events AFTER INSERT writes exactly one event_hosts owner row", () => {
    // The owner row is written by the trigger, not by the test (D9 / SCHEMA §3).
    const rows = runSql(
      `select role || ':' || user_id from public.event_hosts where event_id = '${eventId}';`,
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(rows).toEqual([`owner:${hostId}`]);
  });

  it.skipIf(!LOCAL_UP)("auth.users AFTER INSERT creates a matching profiles row (D7④)", async () => {
    // Prove the trigger end-to-end: create a brand-new auth user via the admin
    // API and assert a profiles row materializes WITHOUT any manual insert.
    const admin = serviceClient();
    const email = "trigger-probe-1-1b@partiful.local";

    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const stale = list?.users.find((u) => u.email?.toLowerCase() === email);
    if (stale) await admin.auth.admin.deleteUser(stale.id);

    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password: "probe-pw-1-1b-9f3a2c",
      email_confirm: true,
    });
    expect(error).toBeNull();
    const uid = created?.user?.id ?? "";
    expect(uid).not.toBe("");
    try {
      expect(scalar(runSql(`select count(*) from public.profiles where id = '${uid}';`))).toBe("1");
    } finally {
      await admin.auth.admin.deleteUser(uid);
    }
  });

  it.skipIf(!LOCAL_UP)("BEFORE UPDATE trigger forces updated_at to now() on rsvps & events", () => {
    // A client-supplied stale updated_at must be overridden by the trigger — the
    // strongest, race-free form of "updated_at trigger works".
    for (const table of ["rsvps", "events"] as const) {
      const idClause = table === "rsvps" ? `event_id = '${eventId}' and guest_id = '${guestId}'` : `id = '${eventId}'`;
      runSql(`update public.${table} set updated_at = timestamptz '2000-01-01 00:00:00+00' where ${idClause};`);
      const epoch = Number(
        scalar(runSql(`select extract(epoch from updated_at)::bigint from public.${table} where ${idClause};`)),
      );
      expect(epoch, `${table}.updated_at must be bumped past the stale value`).toBeGreaterThan(YEAR_2000_EPOCH + 60);
    }
  });

  it.skipIf(!LOCAL_UP)("guests: guest_token defaults to a unique non-null uuid; user_id is nullable", () => {
    const g = jsonRow(
      runSql(
        `with ins as (
           insert into public.guests (event_id, display_name) values ('${eventId}', 'Tokenless')
           returning *
         ) select row_to_json(ins.*) from ins;`,
      ),
    );
    expect(typeof g.guest_token).toBe("string");
    expect((g.guest_token as string).length).toBeGreaterThanOrEqual(32);
    expect(g.user_id).toBeNull();
  });

  it.skipIf(!LOCAL_UP)("rsvps.approval_status defaults to 'approved' and plus_ones to 0 (🟡)", () => {
    const r = jsonRow(
      runSql(
        `with ins as (
           insert into public.rsvps (event_id, guest_id, status) values ('${eventId}', '${guest2Id}', 'maybe')
           returning *
         ) select row_to_json(ins.*) from ins;`,
      ),
    );
    expect(r.approval_status).toBe("approved");
    expect(r.plus_ones).toBe(0);
    // clean up so guest2 stays rsvp-free for the constraint probes below.
    runSql(`delete from public.rsvps where event_id = '${eventId}' and guest_id = '${guest2Id}';`);
  });

  it.skipIf(!LOCAL_UP)("enforces the rsvps.status check (going/maybe/not_going/waitlisted only)", () => {
    expect(() =>
      runSql(`insert into public.rsvps (event_id, guest_id, status) values ('${eventId}', '${guest2Id}', 'definitely');`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces the rsvps.plus_ones >= 0 check", () => {
    expect(() =>
      runSql(`insert into public.rsvps (event_id, guest_id, status, plus_ones) values ('${eventId}', '${guest2Id}', 'going', -1);`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces the rsvps unique(event_id, guest_id) constraint", () => {
    // guestId already has a 'going' rsvp from beforeAll.
    expect(() =>
      runSql(`insert into public.rsvps (event_id, guest_id, status) values ('${eventId}', '${guestId}', 'maybe');`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces the event_hosts.role check (owner/cohost only)", () => {
    // otherHostId is not yet an event_host of this event, so only the role check fires.
    expect(() =>
      runSql(`insert into public.event_hosts (event_id, user_id, role) values ('${eventId}', '${otherHostId}', 'superadmin');`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces the event_hosts unique(event_id, user_id) constraint", () => {
    // The trigger already wrote (event, host[0]) as owner; a second row collides.
    expect(() =>
      runSql(`insert into public.event_hosts (event_id, user_id, role) values ('${eventId}', '${hostId}', 'cohost');`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces guests.display_name NOT NULL", () => {
    expect(() => runSql(`insert into public.guests (event_id) values ('${eventId}');`)).toThrow();
  });

  it.skipIf(!LOCAL_UP)("ships with RLS enabled on event_hosts, guests, rsvps", () => {
    // 1.1b never leaves a new table with RLS off (CLAUDE.md: 绝不削弱 RLS). Full
    // host-isolation assertions live in TEST-SPEC §1.3 (the [SECURITY] pass).
    const rows = runSql(
      `select c.relname || '=' || c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('event_hosts', 'guests', 'rsvps')
        order by c.relname;`,
    )
      .trim()
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    expect(rows).toContain("event_hosts=true");
    expect(rows).toContain("guests=true");
    expect(rows).toContain("rsvps=true");
  });
});
