import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.1a — core tables A migration (0001: profiles + events).
 *
 * 1.1a only creates the DDL. RLS (1.3) and the PostgREST GRANTs that expose
 * tables to anon/authenticated/service_role (1.3/1.4) come later — with
 * auto-expose off, even service_role gets "permission denied" on these tables
 * via PostgREST today. So these assertions hit the DB directly as the `postgres`
 * superuser (bypassing grants/RLS), which is exactly what 1.1a's acceptance is
 * about: "SQL 有效;列/约束齐;集成:可插入 host+event".
 *
 * Gated on a reachable local stack so the suite still skips (green) without
 * Docker; where the stack IS up, the schema must really be there.
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

// Every column from SCHEMA §1 (profiles) and §2 (events) — including the 🟡
// placeholder columns and view_password_hash, which MUST all be built (the task
// does deterministic acceptance against the SCHEMA column list).
const EXPECTED_PROFILE_COLUMNS = ["id", "display_name", "avatar_url", "username", "created_at"];

const EXPECTED_EVENT_COLUMNS = [
  "id", "host_id", "slug", "title", "description", "cover_image_url", "theme", "effect",
  "starts_at", "ends_at", "date_tbd", "location_text", "location_url", "location_city",
  "lat", "lng", "visibility", "view_password_hash", "capacity", "allow_plus_ones",
  "max_plus_ones", "rsvp_enabled", "hide_guest_list", "hide_guest_count",
  "hide_feed_timestamps", "anonymize_guest_list", "allow_photo_upload",
  "guest_approval_enabled", "chip_in_url", "chip_in_note", "status",
  "created_at", "updated_at",
];

describe("task 1.1a: core tables A migration (profiles + events)", () => {
  const i = infra();
  const hostId = i.hosts[0]?.id ?? "00000000-0000-0000-0000-000000000000";
  const otherHostId = i.hosts[1]?.id ?? "11111111-1111-1111-1111-111111111111";
  const SHARED_USERNAME = "host_a_test_1_1a";

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady).toBe(true);
    // A host profile to hang events off (profiles.id FK -> auth.users.id;
    // host[0] is a real confirmed user minted by the global setup).
    runSql(
      `insert into public.profiles (id, display_name, username)
       values ('${hostId}', 'Host A', '${SHARED_USERNAME}')
       on conflict (id) do update set display_name = excluded.display_name,
                                       username = excluded.username;`,
    );
  });

  it.skipIf(!LOCAL_UP)("inserts a host + event carrying every SCHEMA §1/§2 column", () => {
    // One data-modifying CTE -> a single JSON line of output (no command tags).
    const out = runSql(
      `with ev as (
         insert into public.events
           (host_id, title, description, visibility, status,
            location_city, location_text, location_url,
            view_password_hash, capacity, allow_plus_ones, max_plus_ones)
         values
           ('${hostId}', 'Launch Party', 'a description', 'public', 'published',
            'Brooklyn', '123 Secret Address', 'https://maps.example/x',
            null, 50, true, 3)
         returning *
       )
       select row_to_json(ev.*) from ev;`,
    ).trim();
    const row = JSON.parse(out.split("\n").filter(Boolean).pop() ?? "{}");

    for (const col of EXPECTED_EVENT_COLUMNS) {
      expect(row, `events.${col} must exist`).toHaveProperty(col);
    }
    // Stored values round-trip; defaults populate.
    expect(row.visibility).toBe("public");
    expect(row.status).toBe("published");
    expect(row.location_text).toBe("123 Secret Address");
    expect(row.capacity).toBe(50);
    expect(row.max_plus_ones).toBe(3);
    // slug column has a crypto-random fallback default (gen_random_bytes), so an
    // insert without an explicit slug still yields a non-empty unique slug.
    expect(typeof row.slug).toBe("string");
    expect(row.slug.length).toBeGreaterThanOrEqual(10);
    // 🟡 reserved location columns exist and default to null in MVP.
    expect(row.lat).toBeNull();
    expect(row.lng).toBeNull();
  });

  it.skipIf(!LOCAL_UP)("profiles row exposes every SCHEMA §1 column", () => {
    const out = runSql(
      `select row_to_json(p.*) from public.profiles p where p.id = '${hostId}';`,
    ).trim();
    const row = JSON.parse(out.split("\n").filter(Boolean).pop() ?? "{}");
    for (const col of EXPECTED_PROFILE_COLUMNS) {
      expect(row, `profiles.${col} must exist`).toHaveProperty(col);
    }
  });

  it.skipIf(!LOCAL_UP)("enforces the events.visibility check (public/private only)", () => {
    expect(() =>
      runSql(
        `insert into public.events (host_id, title, visibility)
         values ('${hostId}', 'bad-visibility', 'secret');`,
      ),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces the events.status check (draft/published/cancelled only)", () => {
    expect(() =>
      runSql(
        `insert into public.events (host_id, title, status)
         values ('${hostId}', 'bad-status', 'archived');`,
      ),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces the events.slug unique constraint", () => {
    // Two statements run as one implicit transaction; the 2nd violates the
    // unique index and rolls the whole batch back (no residue).
    expect(() =>
      runSql(
        `insert into public.events (host_id, title, slug)
           values ('${hostId}', 'e1', 'dup-slug-1-1a');
         insert into public.events (host_id, title, slug)
           values ('${hostId}', 'e2', 'dup-slug-1-1a');`,
      ),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces the profiles.username unique index", () => {
    // host[1] is a distinct real user; reusing host[0]'s username must fail.
    expect(() =>
      runSql(
        `insert into public.profiles (id, display_name, username)
         values ('${otherHostId}', 'Host B', '${SHARED_USERNAME}');`,
      ),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("ships with RLS enabled on profiles and events", () => {
    // 1.1a never leaves a table with RLS off (CLAUDE.md: 绝不削弱 RLS). Full
    // host-isolation assertions live in TEST-SPEC §1.3 (the [SECURITY] pass).
    const out = runSql(
      `select c.relname || '=' || c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('profiles', 'events')
        order by c.relname;`,
    ).trim();
    const rows = out.split("\n").map((r) => r.trim()).filter(Boolean);
    expect(rows).toContain("events=true");
    expect(rows).toContain("profiles=true");
  });

  it.skipIf(!LOCAL_UP)("allows multiple profiles with NULL username (nullable unique)", () => {
    // Nullable unique index: many NULLs coexist. Insert + rollback, no residue.
    runSql(
      `begin;
       insert into public.profiles (id, display_name, username)
         values ('${otherHostId}', 'Host B', null);
       rollback;`,
    );
    // Reaching here without a throw is the assertion; make it explicit.
    expect(true).toBe(true);
  });
});
