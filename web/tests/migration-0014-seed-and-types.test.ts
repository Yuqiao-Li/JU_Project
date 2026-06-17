import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";
import { WEB_DIR } from "./setup/load-env";

/**
 * Task 1.8 — demo seed (`supabase/seed.sql`) + generated DB types
 * (`web/types/database.ts`).
 *
 * 【测试】is N/A for this 🟢 task (verification is build/typecheck), but a thin
 * red→green spec keeps it honest: the seed must apply cleanly during `supabase db
 * reset` (run by the global setup) and lay down the exact demo shape the later
 * frontend tasks lean on — 1 host, a PUBLIC + a PRIVATE event (the public event's
 * full address is a unique SENTINEL string so a Phase 2.4 SSR leak test has a
 * value to grep, TEST-SPEC §2.4), several guests/rsvps spanning every status, a
 * few comments (host + guest authored), and one date poll (options + votes). The
 * generated type file must exist AND be referenced (wired into the supabase
 * clients) so typecheck/build actually exercise it.
 *
 * Seed rows use the `demo-`/`demo_` namespace and fixed UUIDs so they never
 * collide with the prefixed fixtures the other suites create and tear down. Reads
 * go over psql (postgres superuser): with Supabase auto-expose OFF, anon/service
 * have no API grant on these tables — only the SECURITY DEFINER RPCs do — so the
 * raw rows are inspected directly here. Gated on a reachable local stack so the
 * file skips (green) without Docker.
 */
const LOCAL_UP = localStackRunning();

// ── Pinned demo identifiers (mirrored verbatim in supabase/seed.sql) ──────────
const DEMO_HOST_ID = "d0d00000-0000-4000-8000-000000000001";
const DEMO_HOST_USERNAME = "demo_host";
const SLUG_PUBLIC = "demo-summer-rooftop-bash";
const SLUG_PRIVATE = "demo-members-only-tasting";
/**
 * The public event's full street address (location_text, second tier). A unique
 * sentinel so a未RSVP SSR response can be grepped for a leak (TEST-SPEC §2.4) —
 * keep this string identical to the one in supabase/seed.sql.
 */
const SEED_LOCATION_SENTINEL = "SEED-LOC-SENTINEL-7Kq9mZ2x-do-not-leak";

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

const TYPES_PATH = resolve(WEB_DIR, "types", "database.ts");

describe("task 1.8 — generated DB types are present and referenced", () => {
  it("web/types/database.ts exists and exports a Database type covering the core tables", () => {
    expect(existsSync(TYPES_PATH), "web/types/database.ts must exist (supabase gen types)").toBe(
      true,
    );
    const src = readFileSync(TYPES_PATH, "utf8");
    expect(src, "must export a Database type").toMatch(/export\s+type\s+Database\b/);
    for (const table of [
      "events",
      "guests",
      "rsvps",
      "comments",
      "date_options",
      "date_votes",
      "profiles",
    ]) {
      expect(src, `generated types must include the ${table} table`).toContain(table);
    }
  });

  it("the supabase client helpers reference the generated Database type", () => {
    // 'referenced' (acceptance) — typecheck/build only exercise the file if it's
    // actually imported. Each of the three client paths is parameterised by it.
    for (const file of ["client.ts", "server.ts", "service.ts"]) {
      const src = readFileSync(resolve(WEB_DIR, "lib", "supabase", file), "utf8");
      expect(src, `${file} must import the generated Database type`).toMatch(
        /import\s+type\s+\{\s*Database\s*\}/,
      );
      expect(src, `${file} must parameterise its client with <Database>`).toContain("<Database>");
    }
  });
});

describe.skipIf(!LOCAL_UP)("task 1.8 — demo seed lays down the expected shape", () => {
  it("seeds exactly one demo host profile with a username and display name", () => {
    expect(
      scalar(runSql(`select count(*) from public.profiles where id = '${DEMO_HOST_ID}';`)),
      "demo host profile exists",
    ).toBe("1");
    expect(
      scalar(runSql(`select username from public.profiles where id = '${DEMO_HOST_ID}';`)),
      "demo host has the pinned username",
    ).toBe(DEMO_HOST_USERNAME);
    expect(
      scalar(
        runSql(
          `select coalesce(display_name,'') <> '' from public.profiles where id = '${DEMO_HOST_ID}';`,
        ),
      ),
      "demo host has a display name",
    ).toBe("t");
  });

  it("seeds one PUBLIC published event whose full address is the sentinel", () => {
    expect(
      scalar(
        runSql(
          `select visibility||'/'||status from public.events where slug = '${SLUG_PUBLIC}';`,
        ),
      ),
      "public event is public + published",
    ).toBe("public/published");
    expect(
      scalar(
        runSql(`select location_text from public.events where slug = '${SLUG_PUBLIC}';`),
      ),
      "public event carries the location sentinel (the second-tier full address)",
    ).toBe(SEED_LOCATION_SENTINEL);
    // First-tier city is set too (so the pre-RSVP facade has something to show).
    expect(
      scalar(
        runSql(
          `select coalesce(location_city,'') <> '' from public.events where slug = '${SLUG_PUBLIC}';`,
        ),
      ),
      "public event has a first-tier location_city",
    ).toBe("t");
  });

  it("seeds one PRIVATE event owned by the demo host", () => {
    expect(
      scalar(
        runSql(
          `select visibility from public.events where slug = '${SLUG_PRIVATE}' and host_id = '${DEMO_HOST_ID}';`,
        ),
      ),
      "private event exists and is owned by the demo host",
    ).toBe("private");
  });

  it("both seeded events belong to the single demo host", () => {
    expect(
      scalar(
        runSql(
          `select count(distinct host_id) from public.events where slug in ('${SLUG_PUBLIC}','${SLUG_PRIVATE}');`,
        ),
      ),
      "both demo events share one host",
    ).toBe("1");
  });

  it("seeds several guests + rsvps spanning every status (going/maybe/not_going/waitlisted)", () => {
    const guestCount = Number(
      scalar(
        runSql(
          `select count(*) from public.guests g
             join public.events e on e.id = g.event_id
            where e.slug in ('${SLUG_PUBLIC}','${SLUG_PRIVATE}');`,
        ),
      ),
    );
    expect(guestCount, "several demo guests are seeded").toBeGreaterThanOrEqual(4);

    for (const status of ["going", "maybe", "not_going", "waitlisted"]) {
      const n = Number(
        scalar(
          runSql(
            `select count(*) from public.rsvps r
               join public.events e on e.id = r.event_id
              where e.slug in ('${SLUG_PUBLIC}','${SLUG_PRIVATE}') and r.status = '${status}';`,
          ),
        ),
      );
      expect(n, `at least one '${status}' rsvp is seeded`).toBeGreaterThanOrEqual(1);
    }
  });

  it("seeds a few comments authored by both a guest and the host", () => {
    const total = Number(
      scalar(
        runSql(
          `select count(*) from public.comments c
             join public.events e on e.id = c.event_id
            where e.slug in ('${SLUG_PUBLIC}','${SLUG_PRIVATE}');`,
        ),
      ),
    );
    expect(total, "a few demo comments are seeded").toBeGreaterThanOrEqual(2);
    expect(
      scalar(
        runSql(
          `select count(*) from public.comments c
             join public.events e on e.id = c.event_id
            where e.slug in ('${SLUG_PUBLIC}','${SLUG_PRIVATE}') and c.host_id is not null;`,
        ),
      ),
      "at least one host-authored comment",
    ).not.toBe("0");
    expect(
      scalar(
        runSql(
          `select count(*) from public.comments c
             join public.events e on e.id = c.event_id
            where e.slug in ('${SLUG_PUBLIC}','${SLUG_PRIVATE}') and c.guest_id is not null;`,
        ),
      ),
      "at least one guest-authored comment",
    ).not.toBe("0");
  });

  it("seeds one date poll: options with at least one vote, votes preserved", () => {
    const options = Number(
      scalar(
        runSql(
          `select count(*) from public.date_options o
             join public.events e on e.id = o.event_id
            where e.slug in ('${SLUG_PUBLIC}','${SLUG_PRIVATE}');`,
        ),
      ),
    );
    expect(options, "the date poll has multiple candidate options").toBeGreaterThanOrEqual(2);

    const votes = Number(
      scalar(
        runSql(
          `select count(*) from public.date_votes v
             join public.date_options o on o.id = v.date_option_id
             join public.events e on e.id = o.event_id
            where e.slug in ('${SLUG_PUBLIC}','${SLUG_PRIVATE}');`,
        ),
      ),
    );
    expect(votes, "the date poll has at least one vote").toBeGreaterThanOrEqual(1);
  });
});
