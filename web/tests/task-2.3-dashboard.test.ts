import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anonClient, hostClient, infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";
import { groupEventsByTime, parseMyEvents, type MyEvent } from "../lib/events/feed";

/**
 * Task 2.3 — the unified "your events" dashboard (我主办 + 我参加).
 *
 * Two halves, matching the task's 【测试】 ("集成:get_my_events 只返回自己的;
 * dashboard 只返回该 host 主办活动") plus the data-bearing semantics the page leans on:
 *
 *   A. PURE FEED SHAPING (always runs, no DB). parseMyEvents validates the
 *      get_my_events jsonb at the boundary (zod), and groupEventsByTime splits the
 *      feed into upcoming/past exactly the way the page renders it — a date-TBD or
 *      undated event is always upcoming (it hasn't happened), past sorts newest-
 *      first, upcoming soonest-first with undated last.
 *   B. THE DASHBOARD DATA PATH (integration, gated on a local stack). The feed is
 *      get_my_events on the host's OWN authenticated client, so the security
 *      property is the same one the page depends on: a host sees their hosted
 *      (host_id) ∪ attended (guests.user_id) events, role-discriminated, and NEVER
 *      another host's (不串其他 host 的活动, D1). The detail page reads its own
 *      event's guest list — INCLUDING contact — straight over the host's RLS path
 *      (M1); a non-owner host and anon get nothing.
 *
 * DB state is seeded/read as the postgres superuser (psql) — the established
 * pattern (see task-2.2a / migration-0011 suites) since the client-data tables
 * have no anon/service PostgREST grant; the host/anon client paths probe exactly
 * what the browser hits. Gated so the file skips green without Docker.
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

// ── A) Pure feed shaping — no DB, always runs ────────────────────────────────

/** A minimal valid get_my_events row with overridable fields. */
function row(over: Partial<MyEvent>): MyEvent {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    slug: "slug",
    title: "Title",
    cover_image_url: null,
    starts_at: null,
    ends_at: null,
    date_tbd: false,
    location_city: null,
    visibility: "public",
    status: "published",
    role: "host",
    ...over,
  };
}

describe("task 2.3: get_my_events payload parsing (boundary validation)", () => {
  it("accepts a well-formed jsonb array from get_my_events", () => {
    const payload = [
      { id: "a", slug: "s1", title: "T1", cover_image_url: null, starts_at: "2030-01-01T00:00:00+00:00", ends_at: null, date_tbd: false, location_city: "NYC", visibility: "public", status: "published", role: "host" },
      { id: "b", slug: "s2", title: "T2", cover_image_url: "u", starts_at: null, ends_at: null, date_tbd: true, location_city: null, visibility: "private", status: "draft", role: "guest" },
    ];
    const parsed = parseMyEvents(payload);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].role).toBe("host");
    expect(parsed[1].role).toBe("guest");
  });

  it("returns [] for a non-array / malformed payload instead of throwing", () => {
    expect(parseMyEvents(null)).toEqual([]);
    expect(parseMyEvents("[]")).toEqual([]);
    expect(parseMyEvents([{ id: "x" }])).toEqual([]); // missing required fields
  });

  it("rejects an unknown role value (only host/guest are valid)", () => {
    expect(parseMyEvents([{ ...row({ role: "host" }), role: "admin" }])).toEqual([]);
  });
});

describe("task 2.3: groupEventsByTime (upcoming / past split as the dashboard renders)", () => {
  const NOW = new Date("2026-06-16T12:00:00+00:00");

  it("puts an event whose end is in the past into 'past', a future one into 'upcoming'", () => {
    const past = row({ slug: "past", starts_at: "2020-01-01T00:00:00+00:00" });
    const future = row({ slug: "future", starts_at: "2030-01-01T00:00:00+00:00" });
    const { upcoming, past: pastGroup } = groupEventsByTime([past, future], NOW);
    expect(upcoming.map((e) => e.slug)).toEqual(["future"]);
    expect(pastGroup.map((e) => e.slug)).toEqual(["past"]);
  });

  it("treats a date-TBD or undated event as upcoming (it hasn't happened yet)", () => {
    const tbd = row({ slug: "tbd", date_tbd: true, starts_at: null });
    // date_tbd wins even if a stale starts_at is in the past.
    const tbdStale = row({ slug: "tbd-stale", date_tbd: true, starts_at: "2000-01-01T00:00:00+00:00" });
    const undated = row({ slug: "undated", date_tbd: false, starts_at: null });
    const { upcoming, past } = groupEventsByTime([tbd, tbdStale, undated], NOW);
    expect(past).toHaveLength(0);
    expect(upcoming.map((e) => e.slug).sort()).toEqual(["tbd", "tbd-stale", "undated"]);
  });

  it("uses ends_at over starts_at: an event that started but ends in the future is still upcoming", () => {
    const ongoing = row({ slug: "ongoing", starts_at: "2026-06-16T08:00:00+00:00", ends_at: "2026-06-16T23:00:00+00:00" });
    const { upcoming, past } = groupEventsByTime([ongoing], NOW);
    expect(upcoming.map((e) => e.slug)).toEqual(["ongoing"]);
    expect(past).toHaveLength(0);
  });

  it("sorts upcoming soonest-first with undated last, and past newest-first", () => {
    const events = [
      row({ slug: "u-late", starts_at: "2031-01-01T00:00:00+00:00" }),
      row({ slug: "u-soon", starts_at: "2027-01-01T00:00:00+00:00" }),
      row({ slug: "u-tbd", date_tbd: true }),
      row({ slug: "p-old", starts_at: "2010-01-01T00:00:00+00:00" }),
      row({ slug: "p-recent", starts_at: "2024-01-01T00:00:00+00:00" }),
    ];
    const { upcoming, past } = groupEventsByTime(events, NOW);
    expect(upcoming.map((e) => e.slug)).toEqual(["u-soon", "u-late", "u-tbd"]);
    expect(past.map((e) => e.slug)).toEqual(["p-recent", "p-old"]);
  });
});

// ── B) Dashboard data path — integration ─────────────────────────────────────

const PREFIX = "t23";
const E_A_UP = "t23-a-up"; // host A, future — feed role=host
const E_A_PAST = "t23-a-past"; // host A, past — still mine
const E_A_DRAFT = "t23-a-draft"; // host A, draft — host sees own drafts
const E_B_ATT = "t23-b-att"; // host B, A attends via guests.user_id — feed role=guest
const E_B_OTHER = "t23-b-other"; // host B, A neither hosts nor attends — must NOT appear

const SECRET_CONTACT = "t23-secret-contact@a.example"; // host-only contact on E_A_UP
const T_A_UP_GUEST = "23a00000-0000-4000-8000-000000000001"; // anonymous guest on E_A_UP
const T_B_ATT_A = "23a00000-0000-4000-8000-000000000002"; // A's linked guest on E_B_ATT

type FeedRow = { slug?: string; role?: string };
const slugsOf = (rows: FeedRow[]): string[] => rows.map((r) => String(r.slug));

describe("task 2.3 [integration]: dashboard feed (get_my_events) + host guest-list read", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

  async function myEvents(host: typeof hostA): Promise<FeedRow[]> {
    const { data, error } = await hostClient(host).rpc("get_my_events");
    expect(error, JSON.stringify(error)).toBeNull();
    return parseMyEvents(data) as FeedRow[];
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need host A session").toBeTruthy();
    expect(hostB?.id, "need host B session (the other-host / isolation branch)").toBeTruthy();

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where slug like '${PREFIX}%';`);

    // Events: A hosts three (future / past / draft); B hosts two (one A attends, one not).
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, date_tbd, starts_at, ends_at) values
         ('${hostA.id}','${E_A_UP}',   't23 a up',    'public','published', false, '2030-01-01 18:00:00+00', null),
         ('${hostA.id}','${E_A_PAST}', 't23 a past',  'public','published', false, '2020-01-01 18:00:00+00', '2020-01-01 21:00:00+00'),
         ('${hostA.id}','${E_A_DRAFT}','t23 a draft', 'public','draft',     false, '2030-02-02 18:00:00+00', null),
         ('${hostB.id}','${E_B_ATT}',  't23 b att',   'public','published', false, '2030-03-03 18:00:00+00', null),
         ('${hostB.id}','${E_B_OTHER}','t23 b other', 'public','published', false, '2030-04-04 18:00:00+00', null);`,
    );

    // Guests: a contact-bearing anon guest on E_A_UP (host-only contact + count);
    // A's account-linked guest on E_B_ATT (makes A an attendee of B's event).
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact, user_id) values
         ((select id from public.events where slug='${E_A_UP}'),  '${T_A_UP_GUEST}'::uuid, 't23-going-guest', '${SECRET_CONTACT}', null),
         ((select id from public.events where slug='${E_B_ATT}'), '${T_B_ATT_A}'::uuid,    't23-attendee-a',  null,                '${hostA.id}');`,
    );

    // Both guests are 'going'.
    runSql(
      `insert into public.rsvps (event_id, guest_id, status)
         select g.event_id, g.id, 'going' from public.guests g
         where g.guest_token in ('${T_A_UP_GUEST}'::uuid, '${T_B_ATT_A}'::uuid);`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    // ON DELETE CASCADE clears the seeded guests/rsvps with the event.
    runSql(`delete from public.events where slug like '${PREFIX}%';`);
  });

  // 【测试】get_my_events 只返回自己的 — hosted ∪ attended, role-discriminated, never another host's.
  it.skipIf(!LOCAL_UP)(
    "host A's feed = my hosted (incl. past + draft) ∪ my attended, role-discriminated, and never another host's event",
    async () => {
      const rows = await myEvents(hostA);
      const slugs = slugsOf(rows);

      expect(slugs, "my future hosted event appears").toContain(E_A_UP);
      expect(slugs, "my past hosted event still appears (it's mine)").toContain(E_A_PAST);
      expect(slugs, "my own draft appears on my dashboard").toContain(E_A_DRAFT);
      expect(slugs, "an event I attend via guests.user_id appears").toContain(E_B_ATT);
      expect(slugs, "another host's event I don't attend must NOT appear (不串他人)").not.toContain(E_B_OTHER);

      const bySlug = new Map(rows.map((r) => [String(r.slug), r]));
      expect(bySlug.get(E_A_UP)?.role, "a hosted event is role=host").toBe("host");
      expect(bySlug.get(E_B_ATT)?.role, "an attended event is role=guest").toBe("guest");
    },
  );

  // dashboard 只返回该 host 主办活动 — the other direction: B never sees A's events.
  it.skipIf(!LOCAL_UP)("host B's feed is scoped to B: B hosts E_B_* and never sees A's events", async () => {
    const rows = await myEvents(hostB);
    const slugs = slugsOf(rows);
    expect(slugs, "B hosts E_B_ATT").toContain(E_B_ATT);
    expect(slugs, "B hosts E_B_OTHER").toContain(E_B_OTHER);
    expect(slugs, "B never sees A's hosted event").not.toContain(E_A_UP);
    expect(slugs, "B never sees A's draft").not.toContain(E_A_DRAFT);

    const role = new Map(rows.map((r) => [String(r.slug), r.role]));
    expect(role.get(E_B_ATT), "B is the host of E_B_ATT (host_id authority over the guest row)").toBe("host");
  });

  // The detail page reads its OWN event's full guest list incl. contact via the host RLS path (M1).
  it.skipIf(!LOCAL_UP)(
    "the owning host reads their event's guest list INCLUDING contact; a non-owner host and anon read nothing",
    async () => {
      const eventId = runSql(`select id from public.events where slug='${E_A_UP}';`).trim();

      // Owner host: the same query the detail page runs (rsvps + embedded guest).
      const owner = await hostClient(hostA)
        .from("rsvps")
        .select("status, plus_ones, guests(display_name, contact)")
        .eq("event_id", eventId);
      expect(owner.error, JSON.stringify(owner.error)).toBeNull();
      // The untyped test client infers the to-one `guests` embed as an array; at
      // runtime PostgREST returns a single object (proven by the contact assertion
      // below). Cast through `unknown` to the real runtime shape.
      const ownerRows = (owner.data ?? []) as unknown as Array<{
        status: string;
        guests: { display_name: string; contact: string | null } | null;
      }>;
      expect(ownerRows.length, "owner sees the going guest").toBeGreaterThanOrEqual(1);
      const contacts = ownerRows.map((r) => r.guests?.contact);
      expect(contacts, "the host sees the guest's contact (host-only field, M1)").toContain(SECRET_CONTACT);

      // Non-owner host: RLS returns no rows for someone else's event.
      const other = await hostClient(hostB)
        .from("rsvps")
        .select("status, guests(contact)")
        .eq("event_id", eventId);
      expect(other.error, JSON.stringify(other.error)).toBeNull();
      expect((other.data ?? []).length, "a non-owner host reads none of A's guests").toBe(0);

      // Anon: no grant/policy at all on the client-data tables (G1) — and never contact.
      const an = await anonClient().from("rsvps").select("status, guests(contact)").eq("event_id", eventId);
      expect((an.data ?? []).length, "anon reads nothing from rsvps/guests directly").toBe(0);
    },
  );
});
