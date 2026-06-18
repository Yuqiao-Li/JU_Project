import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";
import { parseMyEvents } from "../lib/events/feed";

/**
 * Task 5 — host UX (audit H9 + H11). Written by the INDEPENDENT adversarial test
 * agent (never wrote the implementation). The black-box SPEC under test:
 *
 *   H9 (DB, migration 0016) — get_my_events now embeds per-event RSVP counts on
 *   each event object it already returns:
 *     going_count    = OCCUPANCY of going RSVPs = sum(1 + plus_ones) over status='going'
 *                      (a +2 going RSVP contributes 3 — NOT a plain row count).
 *     maybe_count    = COUNT of status='maybe' rsvps.
 *     waitlist_count = COUNT of status='waitlisted' rsvps.
 *   not_going RSVPs are excluded from all three. A zero-RSVP event is 0/0/0. One
 *   event's counts never bleed into another's. The pre-existing get_my_events
 *   contract is unchanged: events I host ∪ events I attend (guests.user_id), each
 *   once, role-discriminated, never another user's, [] when unauthenticated.
 *
 *   H9 (client) + H11 (source-grep, no DB) —
 *     - lib/events/feed.ts parses going_count/maybe_count/waitlist_count (they
 *       survive parseMyEvents).
 *     - app/dashboard/page.tsx renders the counts for HOST cards (going_count +
 *       the card.goingCount key).
 *     - app/dashboard/events/[id]/copy-contacts-button.tsx copies "name, contact"
 *       lines and renders nothing when the contact list is empty; the host detail
 *       page builds that list from going+maybe+waitlist guests who left a contact.
 *
 * Seeding/inspection is done as the postgres superuser (psql) — the client-data
 * tables have no anon/service PostgREST grant, so only the DEFINER RPC reaches
 * them (same pattern as the migration-0011 / task-2.3 suites). The counts are
 * read back through the real authenticated host RPC path (get_my_events with the
 * host's JWT). Gated on a reachable local stack so the file skips green w/o Docker.
 */
const LOCAL_UP = localStackRunning();

const FN_MINE = "get_my_events";

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

type ApiResult = { data: unknown; error: { message?: string; code?: string } | null };
type EventRow = {
  slug?: string;
  role?: string;
  going_count?: number;
  maybe_count?: number;
  waitlist_count?: number;
  location_city?: string | null;
};

// ── Sentinels / fixtures ─────────────────────────────────────────────────────
const PREFIX = "t5h"; // cleanup deletes every event whose slug/title starts here
const UNAME_A = "t5h-uname-a";
const UNAME_B = "t5h-uname-b";
const SENTINEL_LOC = "t5h-FULL-ADDRESS-must-not-leak"; // location_text must NOT ride along
const CITY_A = "t5h-city-a"; // location_city — first-tier, may show

// Events (host A unless noted). Each isolates one counting scenario.
const E_MIX = "t5h-mix"; // 2 going(+0,+2) + 2 maybe + 3 waitlist + 1 not_going + (foreign noise)
const E_ZERO = "t5h-zero"; // no RSVPs at all -> 0/0/0
const E_NOTGO = "t5h-notgo"; // only not_going RSVPs -> 0/0/0 (excluded everywhere)
const E_PLUS_ONLY = "t5h-plus"; // single going(+4) -> going_count 5 (occupancy not 1)
const E_GUEST = "t5h-b-guest"; // host B, A attends (role=guest) — counts still present
const E_BOTH = "t5h-both"; // host A AND A is a guest — appears once, role=host
const E_B_OTHER = "t5h-b-other"; // host B, A neither hosts nor attends — must NOT appear

// Deterministic guest tokens (one per seeded RSVP).
const T = (n: number) => `5f000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, "0")}`;
// E_MIX
const T_MIX_GO0 = T(1); // going +0  -> 1
const T_MIX_GO2 = T(2); // going +2  -> 3   (occupancy proof)
const T_MIX_MB1 = T(3); // maybe
const T_MIX_MB2 = T(4); // maybe
const T_MIX_WL1 = T(5); // waitlisted (+5 — proves waitlist is a ROW count, plus_ones ignored)
const T_MIX_WL2 = T(6); // waitlisted
const T_MIX_WL3 = T(7); // waitlisted
const T_MIX_NG1 = T(8); // not_going (excluded everywhere)
// E_NOTGO
const T_NG_A = T(0x11);
const T_NG_B = T(0x12);
// E_PLUS_ONLY
const T_PLUS = T(0x21); // going +4 -> 5
// E_GUEST (host B), A is a going guest there
const T_GUEST_A = T(0x31); // user_id=A, going +1 -> contributes 2
const T_GUEST_X = T(0x32); // anon, maybe
// E_BOTH (host A), A also a guest
const T_BOTH_A = T(0x41); // user_id=A, going +0 -> 1

const COUNTED_TOKENS = [
  T_MIX_GO0, T_MIX_GO2, T_MIX_MB1, T_MIX_MB2, T_MIX_WL1, T_MIX_WL2, T_MIX_WL3, T_MIX_NG1,
  T_NG_A, T_NG_B, T_PLUS, T_GUEST_A, T_GUEST_X, T_BOTH_A,
];

// ─────────────── Migration integrity (catches the root cause directly) ───────────────
//
// migration 0016_get_my_events_counts.sql is what SHIPS H9. For it to take effect it
// must (a) have a UNIQUE numeric version prefix among the migration files, and (b)
// actually be applied to the reset DB. Two assertions pin exactly that — so a
// duplicate/un-applied migration surfaces as one clear failure, not a wall of
// "going_count is undefined".
describe("task 5 [H9]: the get_my_events-counts migration is uniquely numbered and applied", () => {
  const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

  it("each migration file has a UNIQUE leading version number (the CLI keys schema_migrations on it)", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f));
    const byVersion = new Map<string, string[]>();
    for (const f of files) {
      const version = /^(\d+)_/.exec(f)?.[1] ?? "";
      byVersion.set(version, [...(byVersion.get(version) ?? []), f]);
    }
    const collisions = [...byVersion.entries()].filter(([, fs]) => fs.length > 1);
    expect(
      collisions,
      `duplicate migration version prefixes — the supabase CLI keys ` +
        `supabase_migrations.schema_migrations on the leading number, so the second ` +
        `file with a shared prefix is NEVER applied (PK collision): ` +
        JSON.stringify(collisions),
    ).toEqual([]);
  });

  it.skipIf(!LOCAL_UP)("get_my_events in the reset DB actually carries the count fields (0016 applied)", () => {
    const cfg = resolveLocalSupabase({ autoStart: false });
    const hasCounts = execFileSync(
      "psql",
      [
        cfg!.dbUrl,
        "-At",
        "-c",
        "select (pg_get_functiondef('public.get_my_events()'::regprocedure) like '%going_count%' " +
          "and pg_get_functiondef('public.get_my_events()'::regprocedure) like '%maybe_count%' " +
          "and pg_get_functiondef('public.get_my_events()'::regprocedure) like '%waitlist_count%');",
      ],
      { encoding: "utf8" },
    ).trim();
    expect(
      hasCounts,
      "the live get_my_events lacks going/maybe/waitlist_count — 0016_get_my_events_counts.sql " +
        "was not applied (it shares version '0016' with 0016_date_poll.sql, so `supabase db reset` " +
        "hits a schema_migrations PK collision and skips it). Rename it to 0017_*.sql.",
    ).toBe("t");
  });
});

describe("task 5 [H9/H11]: host UX — get_my_events counts + dashboard/contacts wiring", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }
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

  async function callMine(client: SupabaseClient): Promise<{ res: ApiResult; rows: EventRow[] }> {
    const res = (await client.rpc(FN_MINE, {})) as ApiResult;
    // Validate through the real boundary parser so a count-shape regression that
    // breaks parseMyEvents is also caught here. parseMyEvents is permissive on the
    // optional count fields, so we ALSO inspect raw data for the count assertions.
    const raw = (res.data as EventRow[]) ?? [];
    return { res, rows: raw };
  }

  const bySlug = (rows: EventRow[]) => new Map(rows.map((r) => [String(r.slug), r]));
  const slugsOf = (rows: EventRow[]) => rows.map((r) => String(r.slug));

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need host A session").toBeTruthy();
    expect(hostB?.id, "need host B session (isolation branch)").toBeTruthy();

    // Idempotent reset.
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    runSql(`update public.profiles set username=null where username like '${PREFIX}%';`);

    runSql(
      `insert into public.profiles (id, display_name, username) values
         ('${hostA.id}', 't5h host A', '${UNAME_A}'),
         ('${hostB.id}', 't5h host B', '${UNAME_B}')
         on conflict (id) do update
           set display_name = coalesce(public.profiles.display_name, excluded.display_name),
               username      = excluded.username;`,
    );

    // Events. Capacity is irrelevant to counting (counts read raw status), so leave NULL.
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, date_tbd, capacity, location_text, location_city) values
         ('${hostA.id}','${E_MIX}',      't5h mix',    'public', 'published', false, null, '${SENTINEL_LOC}', '${CITY_A}'),
         ('${hostA.id}','${E_ZERO}',     't5h zero',   'public', 'published', false, null, null, null),
         ('${hostA.id}','${E_NOTGO}',    't5h notgo',  'public', 'published', false, null, null, null),
         ('${hostA.id}','${E_PLUS_ONLY}','t5h plus',   'public', 'published', false, null, null, null),
         ('${hostA.id}','${E_BOTH}',     't5h both',   'public', 'published', false, null, null, null),
         ('${hostB.id}','${E_GUEST}',    't5h b guest','public', 'published', false, null, null, null),
         ('${hostB.id}','${E_B_OTHER}',  't5h b other','public', 'published', false, null, null, null);`,
    );

    // Guests. Tokens carry user_id only where A must appear as an attendee.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, user_id) values
         ((select id from public.events where slug='${E_MIX}'),       '${T_MIX_GO0}'::uuid, 't5h-mix-go0', null),
         ((select id from public.events where slug='${E_MIX}'),       '${T_MIX_GO2}'::uuid, 't5h-mix-go2', null),
         ((select id from public.events where slug='${E_MIX}'),       '${T_MIX_MB1}'::uuid, 't5h-mix-mb1', null),
         ((select id from public.events where slug='${E_MIX}'),       '${T_MIX_MB2}'::uuid, 't5h-mix-mb2', null),
         ((select id from public.events where slug='${E_MIX}'),       '${T_MIX_WL1}'::uuid, 't5h-mix-wl1', null),
         ((select id from public.events where slug='${E_MIX}'),       '${T_MIX_WL2}'::uuid, 't5h-mix-wl2', null),
         ((select id from public.events where slug='${E_MIX}'),       '${T_MIX_WL3}'::uuid, 't5h-mix-wl3', null),
         ((select id from public.events where slug='${E_MIX}'),       '${T_MIX_NG1}'::uuid, 't5h-mix-ng1', null),
         ((select id from public.events where slug='${E_NOTGO}'),     '${T_NG_A}'::uuid,    't5h-ng-a',    null),
         ((select id from public.events where slug='${E_NOTGO}'),     '${T_NG_B}'::uuid,    't5h-ng-b',    null),
         ((select id from public.events where slug='${E_PLUS_ONLY}'), '${T_PLUS}'::uuid,    't5h-plus',    null),
         ((select id from public.events where slug='${E_GUEST}'),     '${T_GUEST_A}'::uuid, 't5h-guest-a', '${hostA.id}'),
         ((select id from public.events where slug='${E_GUEST}'),     '${T_GUEST_X}'::uuid, 't5h-guest-x', null),
         ((select id from public.events where slug='${E_BOTH}'),      '${T_BOTH_A}'::uuid,  't5h-both-a',  '${hostA.id}');`,
    );

    // RSVPs keyed by token. plus_ones set where the occupancy math is being probed.
    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_MIX_GO0}'::uuid then 'going'
             when '${T_MIX_GO2}'::uuid then 'going'
             when '${T_MIX_MB1}'::uuid then 'maybe'
             when '${T_MIX_MB2}'::uuid then 'maybe'
             when '${T_MIX_WL1}'::uuid then 'waitlisted'
             when '${T_MIX_WL2}'::uuid then 'waitlisted'
             when '${T_MIX_WL3}'::uuid then 'waitlisted'
             when '${T_MIX_NG1}'::uuid then 'not_going'
             when '${T_NG_A}'::uuid    then 'not_going'
             when '${T_NG_B}'::uuid    then 'not_going'
             when '${T_PLUS}'::uuid    then 'going'
             when '${T_GUEST_A}'::uuid then 'going'
             when '${T_GUEST_X}'::uuid then 'maybe'
             when '${T_BOTH_A}'::uuid  then 'going'
           end,
           case g.guest_token
             when '${T_MIX_GO2}'::uuid then 2
             when '${T_MIX_WL1}'::uuid then 5  -- plus_ones MUST be ignored for waitlist row count
             when '${T_PLUS}'::uuid    then 4
             when '${T_GUEST_A}'::uuid then 1
             else 0
           end
         from public.guests g
         where g.guest_token in (${COUNTED_TOKENS.map((t) => `'${t}'::uuid`).join(",")});`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    runSql(`update public.profiles set username=null where username like '${PREFIX}%';`);
  });

  // ─────────────────────────── H9 — counting semantics ───────────────────────────

  // The headline: going_count is OCCUPANCY (1 + plus_ones), maybe/waitlist are plain
  // ROW counts, not_going is excluded from all three — all on ONE mixed event.
  it.skipIf(!LOCAL_UP)(
    "E_MIX: going_count is occupancy incl. plus_ones (1+3=4), maybe_count=2, waitlist_count=3 (plus_ones ignored), not_going excluded",
    async () => {
      const { res, rows } = await callMine(asHost(hostA.accessToken));
      expect(res.error, JSON.stringify(res.error)).toBeNull();
      const mix = bySlug(rows).get(E_MIX);
      expect(mix, "E_MIX appears in host A's feed").toBeTruthy();

      // going: T_MIX_GO0(+0)=1 and T_MIX_GO2(+2)=3 -> occupancy 4 (NOT row count 2).
      expect(mix?.going_count, "going_count is occupancy 1+3=4, not the row count 2").toBe(4);
      // maybe: two rows.
      expect(mix?.maybe_count, "maybe_count counts the two maybe rows").toBe(2);
      // waitlist: three rows; the +5 on one of them must NOT inflate the count.
      expect(mix?.waitlist_count, "waitlist_count is a ROW count (3) — plus_ones ignored").toBe(3);
    },
  );

  // not_going is invisible to every counter.
  it.skipIf(!LOCAL_UP)(
    "E_NOTGO: an event with only not_going RSVPs reports 0/0/0 (not_going never counts)",
    async () => {
      const { rows } = await callMine(asHost(hostA.accessToken));
      const ng = bySlug(rows).get(E_NOTGO);
      expect(ng, "E_NOTGO appears").toBeTruthy();
      expect(ng?.going_count, "not_going does not count as going").toBe(0);
      expect(ng?.maybe_count, "not_going does not count as maybe").toBe(0);
      expect(ng?.waitlist_count, "not_going does not count as waitlist").toBe(0);
    },
  );

  // Zero RSVPs => 0/0/0 (coalesce, not null/absent).
  it.skipIf(!LOCAL_UP)(
    "E_ZERO: an event with no RSVPs reports 0/0/0 (counts present and zeroed, never null)",
    async () => {
      const { rows } = await callMine(asHost(hostA.accessToken));
      const z = bySlug(rows).get(E_ZERO);
      expect(z, "E_ZERO appears").toBeTruthy();
      expect(z?.going_count, "no-rsvp going_count is 0").toBe(0);
      expect(z?.maybe_count, "no-rsvp maybe_count is 0").toBe(0);
      expect(z?.waitlist_count, "no-rsvp waitlist_count is 0").toBe(0);
      // The fields must be PRESENT (a number), not omitted/null.
      expect(typeof z?.going_count, "going_count present as a number").toBe("number");
      expect(typeof z?.maybe_count, "maybe_count present as a number").toBe("number");
      expect(typeof z?.waitlist_count, "waitlist_count present as a number").toBe("number");
    },
  );

  // A single going(+4) is occupancy 5 — the clearest "not a row count" case.
  it.skipIf(!LOCAL_UP)(
    "E_PLUS_ONLY: a single going RSVP with plus_ones=4 yields going_count 5 (occupancy), not 1",
    async () => {
      const { rows } = await callMine(asHost(hostA.accessToken));
      const p = bySlug(rows).get(E_PLUS_ONLY);
      expect(p, "E_PLUS_ONLY appears").toBeTruthy();
      expect(p?.going_count, "one going(+4) is occupancy 5, not row count 1").toBe(5);
      expect(p?.maybe_count, "no maybe").toBe(0);
      expect(p?.waitlist_count, "no waitlist").toBe(0);
    },
  );

  // No cross-event bleed: each event's object carries ONLY its own counts.
  it.skipIf(!LOCAL_UP)(
    "counts are per-event and never bleed: E_MIX's numbers don't leak into E_ZERO/E_PLUS_ONLY and vice versa",
    async () => {
      const { rows } = await callMine(asHost(hostA.accessToken));
      const m = bySlug(rows);
      // Sanity: three distinct events with three distinct count profiles.
      expect([m.get(E_MIX)?.going_count, m.get(E_ZERO)?.going_count, m.get(E_PLUS_ONLY)?.going_count])
        .toEqual([4, 0, 5]);
      expect([m.get(E_MIX)?.waitlist_count, m.get(E_ZERO)?.waitlist_count, m.get(E_PLUS_ONLY)?.waitlist_count])
        .toEqual([3, 0, 0]);
      expect([m.get(E_MIX)?.maybe_count, m.get(E_ZERO)?.maybe_count, m.get(E_PLUS_ONLY)?.maybe_count])
        .toEqual([2, 0, 0]);
    },
  );

  // Counts come along on ATTENDED (role=guest) events too, and reflect ALL RSVPs on
  // that event (not just the caller's own RSVP).
  it.skipIf(!LOCAL_UP)(
    "an attended event (role=guest) also carries the full per-event counts (all RSVPs, not just mine)",
    async () => {
      const { rows } = await callMine(asHost(hostA.accessToken));
      const g = bySlug(rows).get(E_GUEST);
      expect(g, "E_GUEST (host B, A attends) appears in A's feed").toBeTruthy();
      expect(g?.role, "it is role=guest for A").toBe("guest");
      // E_GUEST: T_GUEST_A going(+1)=occupancy 2; T_GUEST_X maybe.
      expect(g?.going_count, "going occupancy across ALL guests of the attended event (1+1=2)").toBe(2);
      expect(g?.maybe_count, "the other guest's maybe is counted").toBe(1);
      expect(g?.waitlist_count, "no waitlist on E_GUEST").toBe(0);
    },
  );

  // The dashboard reads counts off raw data, but the boundary parser must not strip
  // them. parseMyEvents over the REAL payload keeps the count fields.
  it.skipIf(!LOCAL_UP)(
    "parseMyEvents over the real get_my_events payload preserves going/maybe/waitlist counts (boundary doesn't strip them)",
    async () => {
      const { res } = await callMine(asHost(hostA.accessToken));
      const parsed = parseMyEvents(res.data);
      const mix = parsed.find((e) => e.slug === E_MIX);
      expect(mix, "E_MIX survives parseMyEvents").toBeTruthy();
      expect(mix?.going_count, "going_count survives the zod boundary").toBe(4);
      expect(mix?.maybe_count, "maybe_count survives the zod boundary").toBe(2);
      expect(mix?.waitlist_count, "waitlist_count survives the zod boundary").toBe(3);
    },
  );

  // ─────────────────────── H9 — pre-existing contract still holds ──────────────────────

  it.skipIf(!LOCAL_UP)(
    "the pre-0016 get_my_events contract is intact: hosted ∪ attended, each once, role-discriminated, no cross-host leak, no full address",
    async () => {
      const { res, rows } = await callMine(asHost(hostA.accessToken));
      expect(res.error, JSON.stringify(res.error)).toBeNull();
      const slugs = slugsOf(rows);

      expect(slugs, "a hosted event appears").toContain(E_MIX);
      expect(slugs, "an attended event appears (guests.user_id)").toContain(E_GUEST);
      expect(slugs, "another host's event I don't attend must NOT appear").not.toContain(E_B_OTHER);

      const m = bySlug(rows);
      expect(m.get(E_MIX)?.role, "hosted -> role=host").toBe("host");
      expect(m.get(E_GUEST)?.role, "attended -> role=guest").toBe("guest");

      // host+guest on the same event -> appears ONCE, role=host (host_id authority).
      const bothRows = rows.filter((r) => String(r.slug) === E_BOTH);
      expect(bothRows.length, "host+guest event appears exactly once").toBe(1);
      expect(bothRows[0]?.role, "host+guest event is role=host").toBe("host");
      // ...and its counts are still computed (the going self-RSVP -> occupancy 1).
      expect(bothRows[0]?.going_count, "E_BOTH going_count counts the host's own going RSVP").toBe(1);

      // Desensitized list view: city may show, the full address never does.
      const json = JSON.stringify(rows);
      expect(json, "location_text must NEVER appear in the feed").not.toContain(SENTINEL_LOC);
      expect(json, "location_city is fine to show").toContain(CITY_A);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "get_my_events stays per-caller after 0016: host B never sees A's events; anon and a no-user (service) context get an empty list",
    async () => {
      const bMine = await callMine(asHost(hostB.accessToken));
      expect(bMine.res.error, JSON.stringify(bMine.res.error)).toBeNull();
      const bSlugs = slugsOf(bMine.rows);
      expect(bSlugs, "B hosts E_GUEST + E_B_OTHER").toEqual(expect.arrayContaining([E_GUEST, E_B_OTHER]));
      expect(bSlugs, "B never sees A's hosted event").not.toContain(E_MIX);
      expect(bSlugs, "B never sees A's host+guest event").not.toContain(E_BOTH);
      // For B, E_GUEST is role=host (host_id authority over A's guest row) — counts still present.
      const bGuest = bySlug(bMine.rows).get(E_GUEST);
      expect(bGuest?.role, "E_GUEST is role=host for B").toBe("host");
      expect(bGuest?.going_count, "B sees the same going occupancy on E_GUEST (2)").toBe(2);

      // anon is not granted execute — denied or empty, but never leaks any event.
      const anonMine = await callMine(anon());
      expect(anonMine.rows.length, "anon retrieves no events").toBe(0);

      // service_role IS granted but carries no user sub -> null-guard returns [].
      const ssrMine = await callMine(service());
      expect(ssrMine.res.error, "service_role get_my_events does not error").toBeNull();
      expect(ssrMine.rows.length, "no user context -> empty list (not every event)").toBe(0);
    },
  );

  // Defense-in-depth: cross-check the RPC's going_count against the canonical SQL
  // occupancy formula computed independently over the DB. If the RPC's subquery is
  // wrong (e.g. count(*) instead of sum(1+plus_ones)), this disagrees.
  it.skipIf(!LOCAL_UP)(
    "RPC going_count matches the independent SQL occupancy sum(1+plus_ones where going) for every hosted event",
    async () => {
      const { rows } = await callMine(asHost(hostA.accessToken));
      for (const slug of [E_MIX, E_ZERO, E_NOTGO, E_PLUS_ONLY, E_BOTH]) {
        const r = bySlug(rows).get(slug);
        const sqlGoing = Number(
          runSql(
            `select coalesce(sum(1 + r.plus_ones),0) from public.rsvps r
               join public.events e on e.id=r.event_id
              where e.slug='${slug}' and r.status='going';`,
          ).trim(),
        );
        const sqlMaybe = Number(
          runSql(
            `select count(*) from public.rsvps r join public.events e on e.id=r.event_id
              where e.slug='${slug}' and r.status='maybe';`,
          ).trim(),
        );
        const sqlWait = Number(
          runSql(
            `select count(*) from public.rsvps r join public.events e on e.id=r.event_id
              where e.slug='${slug}' and r.status='waitlisted';`,
          ).trim(),
        );
        expect(r?.going_count, `${slug}: RPC going_count == SQL occupancy`).toBe(sqlGoing);
        expect(r?.maybe_count, `${slug}: RPC maybe_count == SQL maybe rows`).toBe(sqlMaybe);
        expect(r?.waitlist_count, `${slug}: RPC waitlist_count == SQL waitlist rows`).toBe(sqlWait);
      }
    },
  );
});

// ──────────────────── H9 (client) + H11 — pure / source-grep (no DB) ────────────────────

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

describe("task 5 [H9 client]: lib/events/feed.ts parses the per-event counts", () => {
  it("parseMyEvents preserves going_count / maybe_count / waitlist_count on a valid row", () => {
    const payload = [
      {
        id: "a", slug: "s1", title: "T1", cover_image_url: null,
        starts_at: null, ends_at: null, date_tbd: false, location_city: null,
        visibility: "public", status: "published", role: "host",
        going_count: 12, maybe_count: 3, waitlist_count: 5,
      },
    ];
    const parsed = parseMyEvents(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].going_count).toBe(12);
    expect(parsed[0].maybe_count).toBe(3);
    expect(parsed[0].waitlist_count).toBe(5);
  });

  it("a row without the counts still parses (optional — pre-0016 payload), counts undefined", () => {
    const payload = [
      {
        id: "a", slug: "s1", title: "T1", cover_image_url: null,
        starts_at: null, ends_at: null, date_tbd: false, location_city: null,
        visibility: "public", status: "published", role: "host",
      },
    ];
    const parsed = parseMyEvents(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].going_count).toBeUndefined();
    expect(parsed[0].maybe_count).toBeUndefined();
    expect(parsed[0].waitlist_count).toBeUndefined();
  });

  it("a non-numeric count value rejects the row (boundary rejects garbage -> [])", () => {
    const base = {
      id: "a", slug: "s1", title: "T1", cover_image_url: null,
      starts_at: null, ends_at: null, date_tbd: false, location_city: null,
      visibility: "public", status: "published", role: "host",
    };
    expect(parseMyEvents([{ ...base, going_count: "lots" }]), "string count is rejected").toEqual([]);
  });

  it("the feed source actually declares the three count fields", () => {
    const FEED = src("lib/events/feed.ts");
    expect(FEED, "going_count in schema").toMatch(/going_count\s*:/);
    expect(FEED, "maybe_count in schema").toMatch(/maybe_count\s*:/);
    expect(FEED, "waitlist_count in schema").toMatch(/waitlist_count\s*:/);
  });
});

describe("task 5 [H9 client]: dashboard renders counts on HOST cards", () => {
  const PAGE = src("app/dashboard/page.tsx");

  it("the card reads going_count and renders it via the card.goingCount key", () => {
    expect(PAGE, "uses going_count from the event").toContain("event.going_count");
    expect(PAGE, "renders the goingCount translation key").toMatch(/card\.goingCount/);
  });

  it("the count line is gated on the HOST role (an attendee card doesn't show host counts)", () => {
    // The rendered count block is guarded by isHost (the dashboard shows headcount
    // to the organizer, not on the attendee's 'going' card).
    expect(/isHost && [\s\S]*going_count/.test(PAGE), "count block is behind isHost").toBe(true);
  });

  it("the goingCount/waitlistCount/maybeCount message keys exist in both locales", () => {
    const en = JSON.parse(src("messages/en.json")).dashboard.card;
    const zh = JSON.parse(src("messages/zh.json")).dashboard.card;
    for (const k of ["goingCount", "waitlistCount", "maybeCount"] as const) {
      expect(en[k], `en dashboard.card.${k} exists`).toBeTruthy();
      expect(zh[k], `zh dashboard.card.${k} exists`).toBeTruthy();
    }
  });
});

describe("task 5 [H11]: copy-contacts-button formats lines and hides when empty", () => {
  const BTN = src("app/dashboard/events/[id]/copy-contacts-button.tsx");

  it("renders nothing when there are no contacts (returns null on empty list)", () => {
    expect(/contacts\.length === 0\)\s*return null/.test(BTN), "empty list -> render nothing").toBe(true);
  });

  it("formats each guest as `name, contact` joined by newlines", () => {
    expect(BTN, "name, contact template").toContain("`${c.name}, ${c.contact}`");
    expect(/\.join\("\\n"\)/.test(BTN), "lines joined by newline").toBe(true);
  });

  it("writes the formatted text to the clipboard", () => {
    expect(BTN, "uses the clipboard API").toContain("navigator.clipboard.writeText");
  });
});

describe("task 5 [H11]: host detail page builds the contact list from going+maybe+waitlist with a contact", () => {
  const DETAIL = src("app/dashboard/events/[id]/page.tsx");

  it("the contact list is sourced from going + maybe + waitlist guests", () => {
    // The three RSVP groups that may still attend (declined/not_going excluded).
    expect(/\[\.\.\.going,\s*\.\.\.maybe,\s*\.\.\.waitlist\]/.test(DETAIL), "going+maybe+waitlist are the sources").toBe(true);
  });

  it("only guests who actually left a contact are included (empty contacts filtered out)", () => {
    expect(/\.filter\(\(c\)\s*=>\s*c\.contact !== ""\)/.test(DETAIL), "blank-contact rows filtered").toBe(true);
  });

  it("not_going (declined) guests are NOT a source of contacts", () => {
    // 'declined' is built (for the guest list display) but must not feed `contacts`.
    expect(DETAIL, "declined group exists for display").toMatch(/declined = rsvps\.filter/);
    // The contacts array spread must not include `...declined`.
    const contactsLine = /const contacts[^\n]*=\s*\[([^\]]*)\]/.exec(DETAIL)?.[1] ?? "";
    expect(contactsLine.includes("declined"), "declined is not spread into contacts").toBe(false);
  });

  it("the formatted contact object carries the guest's name and contact", () => {
    expect(DETAIL, "name from display_name").toContain("name: r.guests?.display_name");
    expect(DETAIL, "contact from guests.contact").toContain("contact: r.guests?.contact");
  });

  it("the built list is passed to CopyContactsButton", () => {
    expect(/CopyContactsButton contacts=\{contacts\}/.test(DETAIL), "list handed to the button").toBe(true);
  });
});
