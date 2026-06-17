import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";
import {
  groupGuestList,
  guestHeadcount,
  parseGuestList,
  type GuestListEntry,
} from "../lib/events/guest-list";

/**
 * Task 3.1 [SECURITY] — the PUBLIC guest list on /{slug} (TEST-SPEC §3.1).
 * Written by the INDEPENDENT test agent (never wrote the implementation) with the
 * stance "assume the page over-shares the roster, shows declines / the waitlist,
 * leaks a contact or a token, renders the list to a viewer who never unlocked,
 * prints a headcount the host hid, or pulls the list over a realtime channel / a
 * direct browser read of the guests table".
 *
 * Task 3.1 has NO new RPC — it RENDERS get_guest_list (1.5c) on the page, behind
 * visibility-aware polling (D4, NOT Realtime). So the adversarial surface is the
 * FRONT-END boundary, in three layers, each asserted where it actually lives:
 *
 *  A. THE PURE BOUNDARY (web/lib/events/guest-list.ts). parseGuestList /
 *     groupGuestList / guestHeadcount are the client's matching contract — the last
 *     thing between a (possibly regressed/forged) RPC payload and the rendered list.
 *     These are pure (no DB, no server-only, no React), so they're hammered directly
 *     with hostile payloads: a third-tier key riding along (contact/guest_id/token),
 *     a Can't-Go / Waitlisted row, a garbled entry, a negative/fractional/non-finite
 *     +1. The contract must DESENSITIZE + FILTER + FAIL-CLOSED no matter what.
 *
 *  B. THE CLIENT WIRING (static source guard). §3.1 pins "名单靠轮询更新,断言客户端
 *     不订阅/不直 SELECT guests 原表". vitest can't render the React client (server-only
 *     + @/-alias make the page un-importable — see the harness notes), and this is a
 *     STRUCTURAL invariant about HOW the list is fetched, so it's asserted on the
 *     source text: the guest-list client path contains NO realtime channel/subscribe
 *     and NO direct `.from("guests"/"rsvps")` browser read — only a poll of our own
 *     tiered funnel, paused when the tab is hidden. (Grepping API TOKENS like
 *     `.channel(` / `.subscribe(` / `.from("guests")`, never the English words, which
 *     appear in the files' own comments.)
 *
 *  C. THE DATA SOURCE (RPC boundary, real role paths). The page feeds the list from
 *     get_guest_list and the count from get_event_by_slug, both via the trusted role.
 *     The SSR HTML is a strict subset of these payloads, so asserting on them is
 *     stricter than grepping HTML (harness notes / §2.4 posture). §3.1-specific angles
 *     beyond §1.5c: the RPC output piped through parseGuestList renders exactly the
 *     safe set; hide_guest_count OMITS the count KEYS even while the list stays visible
 *     (D7② independence); the roster is reachable ONLY through the RPC (anon has no
 *     direct table grant, G1).
 *
 * Block C is gated on a reachable local stack so the file skips green without Docker;
 * blocks A and B are pure/static and ALWAYS run. Seeding is done as the postgres
 * superuser (psql) since anon/service hold no direct table grant — same pattern as the
 * 1.5x / 2.4 suites. Fixtures are isolated by the per-file `t31` prefix.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Block A — the pure front-end boundary (always runs, no DB)
// ─────────────────────────────────────────────────────────────────────────────

/** A host-only contact value — if the front-end boundary ever lets it through, this
 *  exact string surfaces in the rendered entries. It must NEVER survive. */
const A_SENTINEL_CONTACT = "t31a-contact-secret@sentinel.invalid";
const A_SENTINEL_TOKEN = "31aaaaaa-0000-4000-8000-0000000000ff";
const A_DECLINE_NAME = "t31a-decliner-cantgo";
const A_WAIT_NAME = "t31a-waitlisted-guest";

/** The complete, sorted key set a desensitized entry may EVER expose (D15). */
const ALLOWED_KEYS = ["display_name", "plus_ones", "status"];

describe("task 3.1 [SECURITY] A: the front-end guest-list boundary desensitizes + filters + fails closed (TEST-SPEC §3.1)", () => {
  it("strips every off-contract / third-tier key — a forged payload carrying contact/guest_id/token/user_id yields ONLY display_name/status/plus_ones, and the host-only contact never survives", () => {
    // Simulate a REGRESSED get_guest_list that SELECT *'d the raw row: every host-only
    // column rides along. The front-end boundary is the last line of defence.
    const hostile = [
      {
        display_name: "t31a-alice",
        status: "going",
        plus_ones: 2,
        // Third-tier / internal fields that must be dropped:
        contact: A_SENTINEL_CONTACT,
        guest_id: "31aaaaaa-0000-4000-8000-000000000001",
        guest_token: A_SENTINEL_TOKEN,
        user_id: "31aaaaaa-0000-4000-8000-000000000002",
        event_id: "31aaaaaa-0000-4000-8000-000000000003",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];

    const out = parseGuestList(hostile);
    expect(out, "the valid going entry survives").toHaveLength(1);
    // Exact key set — guest_id/guest_token/contact/user_id/event_id structurally absent.
    expect(Object.keys(out[0]).sort(), "entry exposes ONLY display_name/status/plus_ones").toEqual(
      ALLOWED_KEYS,
    );
    const json = JSON.stringify(out);
    expect(json, "host-only contact must never ride through the boundary").not.toContain(
      A_SENTINEL_CONTACT,
    );
    expect(json, "an internal guest_token must never ride through").not.toContain(A_SENTINEL_TOKEN);
    expect(json, "an internal guest_id must never ride through").not.toContain("guest_id");
    // The carried-through values are gone too.
    expect(out[0].display_name).toBe("t31a-alice");
    expect(out[0].status).toBe("going");
    expect(out[0].plus_ones).toBe(2);
  });

  it("drops Can't-Go (not_going) and Waitlisted rows — only going/maybe survive, and a declined row's riding contact is discarded with it", () => {
    const mixed = [
      { display_name: "t31a-going", status: "going", plus_ones: 0 },
      { display_name: "t31a-maybe", status: "maybe", plus_ones: 0 },
      // A decline that even tries to smuggle a contact — the whole row must vanish.
      { display_name: A_DECLINE_NAME, status: "not_going", plus_ones: 0, contact: A_SENTINEL_CONTACT },
      { display_name: A_WAIT_NAME, status: "waitlisted", plus_ones: 0 },
    ];

    const out = parseGuestList(mixed);
    expect(out.map((e) => e.display_name).sort(), "only going + maybe remain").toEqual([
      "t31a-going",
      "t31a-maybe",
    ]);
    for (const e of out) {
      expect(["going", "maybe"], "no not_going / waitlisted leaks through").toContain(e.status);
    }
    const json = JSON.stringify(out);
    expect(json, "the Can't-Go guest must never appear").not.toContain(A_DECLINE_NAME);
    expect(json, "the waitlisted guest must never appear on this list").not.toContain(A_WAIT_NAME);
    expect(json, "the decline's smuggled contact must never appear").not.toContain(
      A_SENTINEL_CONTACT,
    );
  });

  it("a non-array payload (object / null / string / number / undefined) collapses to [] — the list degrades to 'nobody yet', never throws", () => {
    for (const bad of [null, undefined, {}, "rows", 42, true, { rows: [] }] as const) {
      expect(parseGuestList(bad), `non-array ${JSON.stringify(bad)} ⇒ []`).toEqual([]);
    }
  });

  it("a single malformed entry fails the WHOLE list closed — a half-validated row never renders a partial roster", () => {
    // One good row + one missing display_name ⇒ the array parse fails ⇒ [] (fail closed,
    // no partial leak). A regressed/garbled response shows nothing rather than a stray row.
    expect(
      parseGuestList([
        { display_name: "t31a-ok", status: "going", plus_ones: 0 },
        { status: "going", plus_ones: 0 },
      ]),
      "missing display_name ⇒ whole list []",
    ).toEqual([]);
    // display_name of the wrong type also collapses the list.
    expect(
      parseGuestList([{ display_name: 12345, status: "going", plus_ones: 0 }]),
      "non-string display_name ⇒ []",
    ).toEqual([]);
    // A missing plus_ones (required number) collapses it too — fail closed, not coerced.
    expect(
      parseGuestList([{ display_name: "t31a-x", status: "going" }]),
      "missing plus_ones ⇒ []",
    ).toEqual([]);
  });

  it("sanitizes plus_ones to a non-negative integer — negative ⇒ 0, fractional ⇒ floored, non-finite ⇒ 0 (never a negative or fractional headcount)", () => {
    expect(parseGuestList([{ display_name: "n", status: "going", plus_ones: -5 }])[0].plus_ones,
      "negative +1 clamps to 0").toBe(0);
    expect(parseGuestList([{ display_name: "f", status: "going", plus_ones: 3.7 }])[0].plus_ones,
      "fractional +1 floors to 3").toBe(3);

    // Non-finite (NaN / Infinity): whether the boundary drops the row or zeroes it, the
    // invariant is the same — no surviving entry has a negative/fractional/non-finite +1.
    for (const weird of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = parseGuestList([{ display_name: "w", status: "going", plus_ones: weird }]);
      for (const e of out) {
        expect(Number.isInteger(e.plus_ones) && e.plus_ones >= 0, `non-finite ${weird} ⇒ safe +1`).toBe(
          true,
        );
        expect(e.plus_ones, `non-finite ${weird} normalises to 0`).toBe(0);
      }
    }
  });

  it("groupGuestList splits into Going / Maybe preserving input order within each group", () => {
    const entries = parseGuestList([
      { display_name: "g1", status: "going", plus_ones: 0 },
      { display_name: "m1", status: "maybe", plus_ones: 0 },
      { display_name: "g2", status: "going", plus_ones: 0 },
      { display_name: "m2", status: "maybe", plus_ones: 0 },
    ]);
    const { going, maybe } = groupGuestList(entries);
    expect(going.map((e) => e.display_name), "going group, order preserved").toEqual(["g1", "g2"]);
    expect(maybe.map((e) => e.display_name), "maybe group, order preserved").toEqual(["m1", "m2"]);
    // Empty in ⇒ empty groups out (renders nothing, never crashes).
    expect(groupGuestList([]), "empty list ⇒ empty groups").toEqual({ going: [], maybe: [] });
  });

  it("guestHeadcount counts heads INCLUDING +1s (1 + plus_ones per entry), matching going_count accounting", () => {
    const entries = parseGuestList([
      { display_name: "a", status: "going", plus_ones: 2 },
      { display_name: "b", status: "going", plus_ones: 0 },
      { display_name: "c", status: "going", plus_ones: 1 },
    ]);
    expect(guestHeadcount(entries), "(1+2)+(1+0)+(1+1) = 6").toBe(6);
    expect(guestHeadcount([]), "empty ⇒ 0").toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block B — the client wiring: polling, NOT Realtime; never a direct table read
// ─────────────────────────────────────────────────────────────────────────────

/** Read an implementation source file by repo-relative path (relative to this test). */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

// API tokens (NOT the English words, which appear in the files' own comments).
const REALTIME_CHANNEL = /\.channel\s*\(/;
const REALTIME_SUBSCRIBE = /\.subscribe\s*\(/;
const REALTIME_REMOVE = /removeChannel\s*\(/;
const REALTIME_CHANGES = /postgres_changes/;
/** A direct browser read of the guests/rsvps base tables — the thing §3.1 forbids. */
const DIRECT_TABLE_READ = /\.from\(\s*['"`](guests|rsvps)['"`]/;

describe("task 3.1 [SECURITY] B: the list updates by visibility-aware POLLING, never Realtime, never a direct table read (TEST-SPEC §3.1)", () => {
  const EVENT_CLIENT = src("app/[slug]/event-client.tsx");
  const GUEST_LIST = src("components/events/guest-list.tsx");
  const READ_GUEST_LIST = src("lib/events/read-guest-list.ts");
  const POLL_ROUTE = src("app/api/events/[slug]/route.ts");

  it("the guest-list client path opens NO realtime channel / subscription (D4: 非 Realtime)", () => {
    for (const [name, source] of [
      ["event-client.tsx", EVENT_CLIENT],
      ["guest-list.tsx", GUEST_LIST],
    ] as const) {
      expect(REALTIME_CHANNEL.test(source), `${name}: no supabase .channel(`).toBe(false);
      expect(REALTIME_SUBSCRIBE.test(source), `${name}: no realtime .subscribe(`).toBe(false);
      expect(REALTIME_REMOVE.test(source), `${name}: no removeChannel(`).toBe(false);
      expect(REALTIME_CHANGES.test(source), `${name}: no postgres_changes subscription`).toBe(false);
    }
  });

  it("the guest-list client path NEVER reads the guests/rsvps base tables directly from the browser (G1: 不直 SELECT guests 原表)", () => {
    expect(DIRECT_TABLE_READ.test(EVENT_CLIENT), "event-client.tsx: no direct guests/rsvps SELECT").toBe(
      false,
    );
    expect(DIRECT_TABLE_READ.test(GUEST_LIST), "guest-list.tsx: no direct guests/rsvps SELECT").toBe(
      false,
    );
  });

  it("the list reaches the client ONLY through the polled tiered funnel, paused when the tab is hidden (visibility-aware polling)", () => {
    // It polls OUR endpoint (which proxies the trusted-role tiered RPC), not Supabase直连.
    expect(EVENT_CLIENT, "polls our own tiered funnel").toContain("/api/events/");
    expect(EVENT_CLIENT, "re-reads on an interval (polling, not push)").toContain("setInterval");
    // Visibility-aware: the poll is gated/paused on tab visibility (D4 — don't burn the quota
    // on a hidden tab, and never falsely 429 a normal poller).
    expect(/visibilityState|visibilitychange/.test(EVENT_CLIENT), "visibility-aware polling").toBe(
      true,
    );
  });

  it("the trusted server read reaches the roster ONLY via the get_guest_list RPC (single read path), never a direct table SELECT", () => {
    expect(READ_GUEST_LIST, "goes through the trusted role").toContain("createServiceClient");
    expect(READ_GUEST_LIST, "and through the desensitized RPC, not a raw table read").toContain(
      "get_guest_list",
    );
    expect(
      DIRECT_TABLE_READ.test(READ_GUEST_LIST),
      "read-guest-list.ts: no direct guests/rsvps SELECT",
    ).toBe(false);
  });

  it("the poll endpoint fetches the list ONLY for an UNLOCKED token-holder (a locked / anon read carries no roster)", () => {
    // Defence in depth on top of the RPC's own gate: the route only even asks for the list
    // when the façade came back unlocked. (The RPC re-checks the unlock gate regardless.)
    expect(POLL_ROUTE, "route gates the list fetch on unlocked").toContain("event.unlocked === true");
  });

  it("the headcount NUMBER is render-gated on hide_guest_count (人数不显示) — the component computes its own count from the visible names, so the RPC omitting going_count is NOT sufficient", () => {
    // The page draws its headcount from guestHeadcount(entries) (the visible going/maybe
    // names), NOT from the RPC's going_count. So the ONLY thing that enforces "人数不显示"
    // when hide_guest_count=true is this render gate. If it were dropped, the count would
    // reappear even though Block C proves the RPC omits the going_count key — this asserts
    // the gate is present so the two together fully pin §3.1's "人数不显示".
    expect(
      /showCounts\s*&&[\s\S]{0,160}guestHeadcount\(/.test(GUEST_LIST),
      "guest-list.tsx: the headcount is rendered ONLY behind the showCounts gate",
    ).toBe(true);
    // …and that gate is derived from the host's hide_guest_count flag (D7②, independent of
    // hide_guest_list), so a host can show the names but suppress the number.
    expect(EVENT_CLIENT, "event-client derives showCounts from hide_guest_count").toContain(
      "hide_guest_count",
    );
    expect(
      /showCounts=\{[^}]*hide_guest_count[^}]*\}/.test(EVENT_CLIENT),
      "the showCounts prop is wired from event.hide_guest_count",
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block C — the data source: get_guest_list / get_event_by_slug (DB-backed)
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_UP = localStackRunning();
const FN_LIST = "get_guest_list";
const FN_SLUG = "get_event_by_slug";

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

function scalar(out: string): string {
  return out.trim().split("\n").filter(Boolean).pop() ?? "";
}

/** IN-parameter names of a function, in order — to pin the RPC signature. */
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

type ApiResult = { data: unknown; error: { message?: string } | null };
type EventObj = Record<string, unknown> | null;

function hasKey(obj: EventObj, key: string): boolean {
  return obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

// ── Fixtures (t31 prefix).
const PREFIX = "t31";
const E_ROSTER = "t31-roster"; // public, list+count shown: going/maybe/not_going/waitlisted mix
const E_COUNTHIDDEN = "t31-counthidden"; // public, hide_guest_count=true (list still shown)
const E_HIDDEN = "t31-hidden"; // public, hide_guest_list=true (no list at all)

const C_SENTINEL_CONTACT = "t31-contact-secret@sentinel.invalid"; // host-only; must NEVER appear
const C_DECLINE_NAME = "t31-carol-cantgo"; // not_going — never on the list
const C_WAIT_NAME = "t31-dave-waitlisted"; // waitlisted — never on the list

const T_GOING = "31c00000-0000-4000-8000-000000000001"; // E_ROSTER going +2, carries the contact
const T_MAYBE = "31c00000-0000-4000-8000-000000000002"; // E_ROSTER maybe +0
const T_NOTGOING = "31c00000-0000-4000-8000-000000000003"; // E_ROSTER not_going
const T_WAIT = "31c00000-0000-4000-8000-000000000004"; // E_ROSTER waitlisted
const T_GOING2 = "31c00000-0000-4000-8000-000000000005"; // E_ROSTER going +1
const T_COUNT = "31c00000-0000-4000-8000-000000000006"; // E_COUNTHIDDEN going +1
const T_COUNT_MAYBE = "31c00000-0000-4000-8000-000000000007"; // E_COUNTHIDDEN maybe +0
const T_HIDDEN = "31c00000-0000-4000-8000-000000000008"; // E_HIDDEN going (unlocks, but list hidden)
const T_FORGED = "31c00000-0000-4000-8000-0000000000ff"; // valid uuid, never inserted

const ALL_TOKENS = [
  T_GOING, T_MAYBE, T_NOTGOING, T_WAIT, T_GOING2, T_COUNT, T_COUNT_MAYBE, T_HIDDEN,
];

describe("task 3.1 [SECURITY] C: the page's data source — get_guest_list roster + get_event_by_slug count (TEST-SPEC §3.1)", () => {
  const i = infra();
  const hostA = i.hosts[0];

  function anon(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  /** The trusted SSR/poll path — read-guest-list / read-event use the service role. */
  function service(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.serviceRoleKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async function callList(
    client: SupabaseClient,
    slug: string,
    token?: string,
  ): Promise<{ res: ApiResult; data: unknown }> {
    const body: Record<string, unknown> = { slug };
    if (token !== undefined) body.guest_token = token;
    const res = (await client.rpc(FN_LIST, body)) as ApiResult;
    return { res, data: res.data };
  }

  async function callSlug(
    client: SupabaseClient,
    slug: string,
    token?: string,
  ): Promise<{ res: ApiResult; data: EventObj }> {
    const body: Record<string, unknown> = { slug };
    if (token !== undefined) body.guest_token = token;
    const res = (await client.rpc(FN_SLUG, body)) as ApiResult;
    return { res, data: (res.data as EventObj) ?? null };
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();

    // Pinned signatures — the page's reads depend on these exact arg names.
    expect(inArgNames(FN_LIST), "get_guest_list signature is pinned").toEqual(["slug", "guest_token"]);

    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't31 host A') on conflict (id) do nothing;`,
    );

    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, capacity, allow_plus_ones, max_plus_ones,
          hide_guest_list, hide_guest_count) values
         ('${hostA.id}','${E_ROSTER}',      't31 roster',  'public','published', null, true, 3, false, false),
         ('${hostA.id}','${E_COUNTHIDDEN}', 't31 count',   'public','published', 5,    true, 3, false, true),
         ('${hostA.id}','${E_HIDDEN}',      't31 hidden',  'public','published', null, true, 3, true,  false);`,
    );

    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact) values
         ((select id from public.events where slug='${E_ROSTER}'),      '${T_GOING}'::uuid,       't31-alice-going', '${C_SENTINEL_CONTACT}'),
         ((select id from public.events where slug='${E_ROSTER}'),      '${T_MAYBE}'::uuid,       't31-bob-maybe',   null),
         ((select id from public.events where slug='${E_ROSTER}'),      '${T_NOTGOING}'::uuid,    '${C_DECLINE_NAME}', null),
         ((select id from public.events where slug='${E_ROSTER}'),      '${T_WAIT}'::uuid,        '${C_WAIT_NAME}',  null),
         ((select id from public.events where slug='${E_ROSTER}'),      '${T_GOING2}'::uuid,      't31-frank-going', null),
         ((select id from public.events where slug='${E_COUNTHIDDEN}'), '${T_COUNT}'::uuid,       't31-carol-going', null),
         ((select id from public.events where slug='${E_COUNTHIDDEN}'), '${T_COUNT_MAYBE}'::uuid, 't31-dora-maybe',  null),
         ((select id from public.events where slug='${E_HIDDEN}'),      '${T_HIDDEN}'::uuid,      't31-secret-going', null);`,
    );

    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_GOING}'::uuid       then 'going'
             when '${T_MAYBE}'::uuid       then 'maybe'
             when '${T_NOTGOING}'::uuid    then 'not_going'
             when '${T_WAIT}'::uuid        then 'waitlisted'
             when '${T_GOING2}'::uuid      then 'going'
             when '${T_COUNT}'::uuid       then 'going'
             when '${T_COUNT_MAYBE}'::uuid then 'maybe'
             when '${T_HIDDEN}'::uuid      then 'going'
           end,
           case g.guest_token
             when '${T_GOING}'::uuid  then 2
             when '${T_GOING2}'::uuid then 1
             when '${T_COUNT}'::uuid  then 1
             else 0
           end
         from public.guests g
         where g.guest_token in (
           '${T_GOING}'::uuid,'${T_MAYBE}'::uuid,'${T_NOTGOING}'::uuid,'${T_WAIT}'::uuid,'${T_GOING2}'::uuid,
           '${T_COUNT}'::uuid,'${T_COUNT_MAYBE}'::uuid,'${T_HIDDEN}'::uuid
         );`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  // ── §3.1 bullet 1 — the rendered roster carries no Can't-Go / contact / guest_id / token ──
  it.skipIf(!LOCAL_UP)(
    "the data the page renders (get_guest_list → parseGuestList for an unlocked viewer) is exactly going/maybe with display_name/status/plus_ones — no Can't-Go, no contact, no guest_id/token",
    async () => {
      const r = await callList(service(), E_ROSTER, T_GOING);
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expect(Array.isArray(r.data), "roster is a jsonb array").toBe(true);

      // Raw-RPC structural checks (third-tier absent at the source).
      const rawJson = JSON.stringify(r.data);
      expect(rawJson, "host-only contact must never be in the roster payload").not.toContain(
        C_SENTINEL_CONTACT,
      );
      for (const tok of ALL_TOKENS) {
        expect(rawJson, `guest_token ${tok} must never appear`).not.toContain(tok);
      }
      expect(rawJson, "the Can't-Go guest must never appear").not.toContain(C_DECLINE_NAME);
      expect(rawJson, "the waitlisted guest must never appear on this list").not.toContain(C_WAIT_NAME);

      // Pipe through the ACTUAL front-end boundary the page uses, then re-assert.
      const entries = parseGuestList(r.data);
      expect(entries.map((e) => e.display_name).sort(), "exactly alice/bob/frank (decline+waitlist excluded)").toEqual([
        "t31-alice-going",
        "t31-bob-maybe",
        "t31-frank-going",
      ]);
      for (const e of entries) {
        expect(Object.keys(e).sort(), "rendered entry exposes only the 3 safe keys").toEqual(
          ALLOWED_KEYS,
        );
        expect(["going", "maybe"], "rendered status is going|maybe only").toContain(e.status);
      }

      // Grouping + headcount the page draws. (Display order between two same-timestamp
      // going guests is the RPC's created_at→guest-id tiebreak, not a §3.1 property, so
      // membership is asserted order-independently.)
      const { going, maybe } = groupGuestList(entries);
      expect(going.map((e) => e.display_name).sort(), "Going group = alice + frank").toEqual([
        "t31-alice-going",
        "t31-frank-going",
      ]);
      expect(maybe.map((e) => e.display_name), "Maybe group = bob").toEqual(["t31-bob-maybe"]);
      expect(guestHeadcount(going), "Going heads incl +1s = (1+2)+(1+1) = 5").toBe(5);
      expect(guestHeadcount(maybe), "Maybe heads = 1").toBe(1);
    },
  );

  // ── §3.1 bullet 2 — an un-unlocked viewer's render input is empty (名单不可见) ──
  it.skipIf(!LOCAL_UP)(
    "an un-unlocked viewer (no token / forged token / a not_going decline) gets [] as render input ⇒ the page shows no list",
    async () => {
      for (const [label, token] of [
        ["no-token", undefined],
        ["forged-token", T_FORGED],
        ["decliner-token", T_NOTGOING],
      ] as const) {
        const r = await callList(service(), E_ROSTER, token);
        expect(r.res.error, `${label}: ${JSON.stringify(r.res.error)}`).toBeNull();
        expect(Array.isArray(r.data) && (r.data as unknown[]).length, `${label}: empty roster`).toBe(0);
        // The front-end boundary likewise produces nothing to render.
        expect(parseGuestList(r.data), `${label}: nothing to render`).toEqual([]);
      }
    },
  );

  // ── §3.1 bullet 3 — hide_guest_count OMITS the count KEYS even while the list stays visible (D7②) ──
  it.skipIf(!LOCAL_UP)(
    "hide_guest_count=true ⇒ the event façade omits going_count AND capacity_remaining (人数不显示, RPC 返回体无 count 键) while the roster is STILL returned — the two flags are independent",
    async () => {
      // Control: list+count shown ⇒ going_count is present and correct (going-only, incl +1s).
      const shown = await callSlug(service(), E_ROSTER, T_GOING);
      expect(shown.data?.unlocked, "going token unlocks").toBe(true);
      expect(hasKey(shown.data, "going_count"), "count shown ⇒ going_count key present").toBe(true);
      expect(shown.data?.going_count, "occupancy = alice(1+2)+frank(1+1) = 5").toBe(5);

      // hide_guest_count=true ⇒ the count keys are OMITTED (not zeroed)…
      const hiddenCount = await callSlug(service(), E_COUNTHIDDEN, T_COUNT);
      expect(hiddenCount.data?.unlocked, "unlocked caller").toBe(true);
      expect(hasKey(hiddenCount.data, "going_count"), "hide_guest_count ⇒ going_count key OMITTED").toBe(
        false,
      );
      expect(
        hasKey(hiddenCount.data, "capacity_remaining"),
        "hide_guest_count ⇒ capacity_remaining key OMITTED",
      ).toBe(false);
      expect(hiddenCount.data?.hide_guest_count, "the flag itself is surfaced for the renderer").toBe(
        true,
      );

      // …yet the LIST is still visible (hide_guest_list is false): names render, count doesn't.
      const list = await callList(service(), E_COUNTHIDDEN, T_COUNT);
      expect(list.res.error, JSON.stringify(list.res.error)).toBeNull();
      const entries = parseGuestList(list.data);
      expect(entries.map((e) => e.display_name).sort(), "list shown: carol(going)+dora(maybe)").toEqual([
        "t31-carol-going",
        "t31-dora-maybe",
      ]);
    },
  );

  // ── §3.1 — hide_guest_list=true ⇒ no list at all, even for an unlocked caller ──
  it.skipIf(!LOCAL_UP)(
    "hide_guest_list=true ⇒ the page's list source returns [] even for an unlocked (going) caller",
    async () => {
      const r = await callList(service(), E_HIDDEN, T_HIDDEN);
      expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
      expect(Array.isArray(r.data) && (r.data as unknown[]).length, "hidden list ⇒ []").toBe(0);
      expect(parseGuestList(r.data), "nothing to render for a hidden list").toEqual([]);
    },
  );

  // ── §3.1 bullet 4 (data side) — the roster is reachable ONLY through the RPC (G1) ──
  it.skipIf(!LOCAL_UP)(
    "anon cannot read guests/rsvps directly from the browser — the roster reaches the page ONLY through the RPC funnel (G1: 不给 anon 开原表 SELECT)",
    async () => {
      const an = anon();
      const evId = scalar(runSql(`select id from public.events where slug='${E_ROSTER}';`));

      const g = await an.from("guests").select("*").eq("event_id", evId);
      expect((g.data ?? []).length, "anon direct SELECT on guests must leak no rows").toBe(0);
      const rs = await an.from("rsvps").select("*").eq("event_id", evId);
      expect((rs.data ?? []).length, "anon direct SELECT on rsvps must leak no rows").toBe(0);
      const c = await an.from("guests").select("contact").eq("event_id", evId);
      expect(JSON.stringify(c.data ?? []), "anon must not read any contact").not.toContain(
        C_SENTINEL_CONTACT,
      );
    },
  );

  // ── §3.1 更狠 — the RPC gate (not caller privilege) governs: anon and the trusted role
  //     get the SAME desensitized roster for the same token ──
  it.skipIf(!LOCAL_UP)(
    "the desensitized roster is identical over anon (browser, with token) and the trusted role — the unlock GATE governs, not who calls",
    async () => {
      const viaAnon = parseGuestList((await callList(anon(), E_ROSTER, T_GOING)).data);
      const viaService = parseGuestList((await callList(service(), E_ROSTER, T_GOING)).data);
      expect(viaAnon.map((e) => e.display_name).sort(), "anon sees the same safe roster").toEqual(
        viaService.map((e) => e.display_name).sort(),
      );
      // And neither path ever carries the contact.
      expect(JSON.stringify(viaAnon), "anon path: no contact").not.toContain(C_SENTINEL_CONTACT);
    },
  );
});
