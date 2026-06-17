import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anonClient, infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";
import {
  groupPublicEventsByTime,
  parsePublicEvents,
  type PublicEvent,
} from "../lib/events/public-events";

/**
 * Task 6.1 — the Organizer Profile at `/u/[username]`.
 *
 * The page resolves a username to a host and lists ONLY that host's public +
 * published events — through `get_public_events_by_host` (SECURITY DEFINER, D2),
 * never by querying `events` directly as anon (不 anon 直查表). Two halves:
 *
 *   A. PURE BOUNDARY SHAPING (always runs, no DB). parsePublicEvents validates the
 *      RPC jsonb with zod, and — crucially — the view schema has NO visibility /
 *      status / location_text fields, so even a forged or buggy payload that smuggles
 *      private metadata is normalized down to the public façade before it can reach a
 *      render. groupPublicEventsByTime splits the list into upcoming / past the way
 *      the page groups it.
 *   B. THE PROFILE DATA PATH (integration, gated on a local stack). With a username
 *      assigned to host A, the anon RPC returns A's public+published event and NEVER a
 *      private event, a draft, a cancelled event, or another host's event — while a
 *      direct anon SELECT on `events` returns nothing (the data is reachable only via
 *      the DEFINER RPC). This is exactly TASKS 6.1 【测试】 ("不含 private;走 RPC 非
 *      直查表") and TEST-SPEC §1.5e (get_public_events_by_host: only public+published).
 *
 * DB state is seeded/read as the postgres superuser (psql) — the established pattern
 * (see task-2.3 / migration-0011 suites) since the client-data tables have no anon
 * grant; the anon client path probes exactly what the browser hits. Gated so the file
 * skips green without Docker.
 */
const LOCAL_UP = localStackRunning();

function runSql(sql: string): string {
  const cfg = resolveLocalSupabase({ autoStart: false });
  if (!cfg) throw new Error("local supabase stack not reachable");
  return execFileSync("psql", [cfg.dbUrl, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ── A) Pure boundary shaping — no DB, always runs ────────────────────────────

/** A minimal valid get_public_events_by_host row with overridable fields. */
function row(over: Partial<PublicEvent>): PublicEvent {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    slug: "slug",
    title: "Title",
    description: null,
    cover_image_url: null,
    starts_at: null,
    ends_at: null,
    date_tbd: false,
    location_city: null,
    ...over,
  };
}

describe("task 6.1: parsePublicEvents (boundary validation strips non-public fields)", () => {
  it("accepts a well-formed get_public_events_by_host jsonb array", () => {
    const payload = [
      {
        id: "a",
        slug: "summer-bbq-x7k2m9qpvw",
        title: "Summer BBQ",
        description: "come thru",
        cover_image_url: "https://example.test/cover.jpg",
        starts_at: "2030-07-04T18:00:00+00:00",
        ends_at: null,
        date_tbd: false,
        location_city: "Brooklyn",
      },
    ];
    const parsed = parsePublicEvents(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].slug).toBe("summer-bbq-x7k2m9qpvw");
    expect(parsed[0].location_city).toBe("Brooklyn");
  });

  it("returns [] for a non-array / malformed payload instead of throwing", () => {
    expect(parsePublicEvents(null)).toEqual([]);
    expect(parsePublicEvents("[]")).toEqual([]);
    expect(parsePublicEvents([{ id: "x" }])).toEqual([]); // missing required fields
  });

  it("strips smuggled private metadata — the view can never carry visibility/status/location_text", () => {
    // A forged or buggy RPC payload tries to sneak in private-only fields. The schema
    // doesn't model them, so they are dropped before the profile can ever render them.
    const parsed = parsePublicEvents([
      {
        ...row({ slug: "leaky" }),
        visibility: "private",
        status: "draft",
        location_text: "221B Baker Street",
        host_id: "secret-host-uuid",
        contact: "host@secret.example",
      },
    ]);
    expect(parsed).toHaveLength(1);
    const keys = Object.keys(parsed[0]);
    for (const banned of ["visibility", "status", "location_text", "host_id", "contact"]) {
      expect(keys, `the public view must not carry ${banned}`).not.toContain(banned);
    }
  });
});

describe("task 6.1: groupPublicEventsByTime (upcoming / past split as the profile renders)", () => {
  const NOW = new Date("2026-06-17T12:00:00+00:00");

  it("splits past vs upcoming and treats a date-TBD event as upcoming", () => {
    const past = row({ slug: "past", starts_at: "2020-01-01T00:00:00+00:00" });
    const future = row({ slug: "future", starts_at: "2030-01-01T00:00:00+00:00" });
    const tbd = row({ slug: "tbd", date_tbd: true, starts_at: null });
    const { upcoming, past: pastGroup } = groupPublicEventsByTime([past, future, tbd], NOW);
    expect(upcoming.map((e) => e.slug).sort()).toEqual(["future", "tbd"]);
    expect(pastGroup.map((e) => e.slug)).toEqual(["past"]);
  });

  it("sorts upcoming soonest-first with undated last, and past newest-first", () => {
    const events = [
      row({ slug: "u-late", starts_at: "2031-01-01T00:00:00+00:00" }),
      row({ slug: "u-soon", starts_at: "2027-01-01T00:00:00+00:00" }),
      row({ slug: "u-tbd", date_tbd: true }),
      row({ slug: "p-old", starts_at: "2010-01-01T00:00:00+00:00" }),
      row({ slug: "p-recent", starts_at: "2024-01-01T00:00:00+00:00" }),
    ];
    const { upcoming, past } = groupPublicEventsByTime(events, NOW);
    expect(upcoming.map((e) => e.slug)).toEqual(["u-soon", "u-late", "u-tbd"]);
    expect(past.map((e) => e.slug)).toEqual(["p-recent", "p-old"]);
  });
});

// ── B) Profile data path — integration ───────────────────────────────────────

const PREFIX = "t61";
const USERNAME = "t61organizer"; // assigned to host A for this suite
const E_A_PUB = "t61-a-pub"; // host A, public + published → MUST appear
const E_A_PRIV = "t61-a-priv"; // host A, private + published → MUST be excluded
const E_A_DRAFT = "t61-a-draft"; // host A, public + draft → MUST be excluded
const E_A_CANCELLED = "t61-a-cancelled"; // host A, public + cancelled → MUST be excluded
const E_B_PUB = "t61-b-pub"; // host B, public + published → MUST be excluded (other host)
const SENTINEL_LOC = "t61-secret-street-do-not-leak"; // full address on the private event

type ApiRow = { slug?: string };

describe("task 6.1 [integration]: organizer profile (get_public_events_by_host)", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need host A session").toBeTruthy();
    expect(hostB?.id, "need host B session (the other-host exclusion branch)").toBeTruthy();

    // Idempotent reset (slug + username are UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where slug like '${PREFIX}%';`);
    runSql(`update public.profiles set username=null where username like '${PREFIX}%';`);

    // Give host A the public handle this profile resolves.
    runSql(`update public.profiles set username='${USERNAME}' where id='${hostA.id}';`);

    // Host A: one public+published (visible), plus a private, a draft and a cancelled
    // (all hidden). Host B: a public+published that must never appear on A's profile.
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, date_tbd, starts_at, location_text, location_city) values
         ('${hostA.id}','${E_A_PUB}',      't61 a pub',      'public', 'published', false,'2030-01-01 18:00:00+00', null,            'Queens'),
         ('${hostA.id}','${E_A_PRIV}',     't61 a priv',     'private','published', false,'2030-02-02 18:00:00+00', '${SENTINEL_LOC}','Queens'),
         ('${hostA.id}','${E_A_DRAFT}',    't61 a draft',    'public', 'draft',     false,'2030-03-03 18:00:00+00', null,            'Queens'),
         ('${hostA.id}','${E_A_CANCELLED}','t61 a cancelled','public', 'cancelled', false,'2030-04-04 18:00:00+00', null,            'Queens'),
         ('${hostB.id}','${E_B_PUB}',      't61 b pub',      'public', 'published', false,'2030-05-05 18:00:00+00', null,            'Queens');`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where slug like '${PREFIX}%';`);
    runSql(`update public.profiles set username=null where username like '${PREFIX}%';`);
  });

  // TASKS 6.1 【测试】: 不含 private;走 RPC. TEST-SPEC §1.5e: only public+published.
  it.skipIf(!LOCAL_UP)(
    "anon RPC returns host A's public+published event only — never private/draft/cancelled or another host's",
    async () => {
      const { data, error } = await anonClient().rpc("get_public_events_by_host", {
        username: USERNAME,
      });
      expect(error, JSON.stringify(error)).toBeNull();

      const rows = (data ?? []) as ApiRow[];
      const slugs = rows.map((r) => String(r.slug));

      expect(slugs, "the public+published event appears").toContain(E_A_PUB);
      expect(slugs, "a PRIVATE event is never on the public profile").not.toContain(E_A_PRIV);
      expect(slugs, "a DRAFT event is never on the public profile").not.toContain(E_A_DRAFT);
      expect(slugs, "a CANCELLED event is never on the public profile").not.toContain(E_A_CANCELLED);
      expect(slugs, "another host's event never appears here").not.toContain(E_B_PUB);

      // The full address of the private event must not ride along anywhere in the payload.
      expect(JSON.stringify(data), "the private event's full address never leaks").not.toContain(
        SENTINEL_LOC,
      );
      // First-tier façade only: no full street address key even for the visible event.
      expect(JSON.stringify(data), "no full address (location_text) on the profile feed").not.toContain(
        "location_text",
      );

      // Parsed through the view boundary: the visible event survives, carries no
      // private metadata, and the private slug is absent.
      const parsed = parsePublicEvents(data);
      expect(parsed.map((e) => e.slug)).toContain(E_A_PUB);
      expect(parsed.map((e) => e.slug)).not.toContain(E_A_PRIV);
      expect(parsed.every((e) => !("visibility" in e))).toBe(true);
    },
  );

  // 走 RPC 非直查表: anon can reach the curated list ONLY through the DEFINER RPC; a
  // direct table read returns nothing (G1 — no anon grant/policy on events).
  it.skipIf(!LOCAL_UP)(
    "anon cannot read the events table directly — the profile data exists only via the RPC",
    async () => {
      const direct = await anonClient()
        .from("events")
        .select("slug, visibility, status")
        .eq("host_id", hostA.id);
      // No anon SELECT policy/grant ⇒ empty (RLS) rather than rows. Never an error path
      // that would still imply the table is anon-reachable.
      expect((direct.data ?? []).length, "anon direct SELECT on events yields nothing").toBe(0);

      // …yet the same anon role gets the curated public list through the RPC.
      const viaRpc = await anonClient().rpc("get_public_events_by_host", { username: USERNAME });
      expect(viaRpc.error, JSON.stringify(viaRpc.error)).toBeNull();
      expect((viaRpc.data as ApiRow[]).map((r) => String(r.slug))).toContain(E_A_PUB);
    },
  );

  // An unknown username is no existence oracle (D2): empty list, not an error / 404.
  it.skipIf(!LOCAL_UP)("an unknown username yields an empty list, not an error", async () => {
    const { data, error } = await anonClient().rpc("get_public_events_by_host", {
      username: "t61-no-such-organizer-xyz",
    });
    expect(error, JSON.stringify(error)).toBeNull();
    expect(parsePublicEvents(data)).toEqual([]);
  });
});
