import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anonClient, hostClient, infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 2.3 — ADVERSARIAL suite (independent test engineer, did NOT write the impl).
 *
 * The companion task-2.3-dashboard.test.ts proves the happy paths. This file is the
 * skeptic's pass: it assumes get_my_events / the host-detail data path leak or
 * mis-scope, and tries to make them. Mapped to TEST-SPEC §1.5e (get_my_events 只返回
 * 自己的), §1.3 (host isolation + M1 self-read + 第三类 host-only data) and §1.4
 * (contact / address never reach a non-host). Concretely it attacks:
 *
 *   1. FIELD-LEVEL LEAK in get_my_events. The dashboard validates with zod
 *      (parseMyEvents), which STRIPS unknown keys — so a feed that smuggled
 *      `contact` / `location_text` / `host_id` / `view_password_hash` / `user_id`
 *      would pass the happy-path test silently. Here we inspect the RAW jsonb and
 *      additionally scan the serialized body for an address sentinel and the
 *      host-only contact sentinels seeded onto MY OWN events.
 *   2. ATTEND-BRANCH SCOPE (D1). "我参加" is keyed on guests.user_id = auth.uid(),
 *      NOT on a bare token and NOT on event existence. A token-only guest row
 *      (user_id NULL) and a foreign-user_id row must NOT surface in my feed — and we
 *      prove the rows are REAL by confirming the owning host B does see them, so the
 *      exclusion is scoping, not absence. A PRIVATE event I genuinely attend MUST
 *      surface (the feed must not over-filter). An event I both host AND attend must
 *      appear EXACTLY ONCE, role='host' (D9 authority + dedup).
 *   3. anon → get_my_events leaks nobody's events (empty / denied, never rows).
 *   4. HOST DETAIL DATA PATH. The owning host reads the FULL list incl. the
 *      not_going + waitlisted rows a guest's get_guest_list never returns (第三类),
 *      with contact (M1); the detail page's FIRST query (the events row itself) is
 *      RLS-isolated — a non-owner host and anon get null → notFound(), never the row.
 *
 * Seeded/read as the postgres superuser (psql) — the established pattern: the
 * client-data tables have no anon/service PostgREST grant, so the host/anon CLIENT
 * paths probe exactly what the browser hits. Gated on a local stack; skips green
 * without Docker.
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

// Distinct prefix from the companion file (t23) so the two suites never collide on
// the shared DB (fileParallelism:false runs them serially; each cleans its prefix).
const PREFIX = "t23x";
const E_HOST_ATTEND = "t23x-host-attend"; // A hosts AND attends → role=host, appears once
const E_PRIV_ATTEND = "t23x-priv-attend"; // B hosts, PRIVATE; A attends → role=guest, must appear
const E_TOKEN_ONLY = "t23x-token-only"; // B hosts; A's row is token-only (user_id NULL) → excluded
const E_FOREIGN = "t23x-foreign"; // B hosts; guest row user_id=B → excluded from A's feed
const E_FULL = "t23x-full-status"; // A hosts; guests across ALL four statuses, each w/ contact

// Sentinels that must NEVER appear in get_my_events output even though they live on
// events/guests A legitimately owns (the feed is a first-tier, desensitized view).
const ADDR_SENTINEL = "t23x-FULL-STREET-ADDR-7q9z"; // events.location_text on E_HOST_ATTEND
const C_GO = "t23x-contact-going@e.example";
const C_MB = "t23x-contact-maybe@e.example";
const C_NG = "t23x-contact-decline@e.example";
const C_WL = "t23x-contact-wait@e.example";

// Guest tokens (never asserted against — only used to wire RSVP statuses by row).
const T_HA = "23b00000-0000-4000-8000-000000000001";
const T_PA = "23b00000-0000-4000-8000-000000000002";
const T_TOK = "23b00000-0000-4000-8000-000000000003";
const T_FOR = "23b00000-0000-4000-8000-000000000004";
const T_FS_GO = "23b00000-0000-4000-8000-000000000011";
const T_FS_MB = "23b00000-0000-4000-8000-000000000012";
const T_FS_NG = "23b00000-0000-4000-8000-000000000013";
const T_FS_WL = "23b00000-0000-4000-8000-000000000014";

// The first-tier keys get_my_events is allowed to emit. Anything else is a leak.
const ALLOWED_FEED_KEYS = new Set([
  "id",
  "slug",
  "title",
  "cover_image_url",
  "starts_at",
  "ends_at",
  "date_tbd",
  "location_city",
  "visibility",
  "status",
  "role",
]);
// Explicit deny-list of sensitive columns that must never ride along.
const BANNED_FEED_KEYS = [
  "contact",
  "location_text",
  "location_url",
  "host_id",
  "guest_token",
  "view_password_hash",
  "user_id",
  "description",
  "lat",
  "lng",
];

type FeedRow = Record<string, unknown>;

describe("task 2.3 [adversarial]: get_my_events leak/scope + host-detail isolation", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

  /** RAW get_my_events jsonb (NOT parsed — parsing would strip a leaked key). */
  async function rawFeed(host: typeof hostA): Promise<FeedRow[]> {
    const { data, error } = await hostClient(host).rpc("get_my_events");
    expect(error, JSON.stringify(error)).toBeNull();
    expect(Array.isArray(data), "get_my_events returns a jsonb array").toBe(true);
    return data as FeedRow[];
  }

  const slugsOf = (rows: FeedRow[]): string[] => rows.map((r) => String(r.slug));

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need host A session").toBeTruthy();
    expect(hostB?.id, "need host B session (isolation branch)").toBeTruthy();

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where slug like '${PREFIX}%';`);

    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, date_tbd, starts_at, location_text, location_city) values
         ('${hostA.id}','${E_HOST_ATTEND}','t23x host attend','public', 'published', false, '2030-05-05 18:00:00+00', '${ADDR_SENTINEL}', 'Testville'),
         ('${hostB.id}','${E_PRIV_ATTEND}','t23x priv attend','private','published', false, '2030-06-06 18:00:00+00', null, null),
         ('${hostB.id}','${E_TOKEN_ONLY}', 't23x token only','public', 'published', false, '2030-07-07 18:00:00+00', null, null),
         ('${hostB.id}','${E_FOREIGN}',    't23x foreign',    'public', 'published', false, '2030-08-08 18:00:00+00', null, null),
         ('${hostA.id}','${E_FULL}',       't23x full status','public', 'published', false, '2030-09-09 18:00:00+00', null, null);`,
    );

    // Guests:
    //  - E_HOST_ATTEND: A's account-linked row (makes A both host AND attendee).
    //  - E_PRIV_ATTEND: A's account-linked row on B's PRIVATE event (A attends).
    //  - E_TOKEN_ONLY:  token-only row, user_id NULL — A has NO account link.
    //  - E_FOREIGN:     row linked to host B (a DIFFERENT account).
    //  - E_FULL:        four anonymous guests, each carrying a host-only contact.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact, user_id) values
         ((select id from public.events where slug='${E_HOST_ATTEND}'), '${T_HA}'::uuid,  't23x ha',  null,    '${hostA.id}'),
         ((select id from public.events where slug='${E_PRIV_ATTEND}'), '${T_PA}'::uuid,  't23x pa',  null,    '${hostA.id}'),
         ((select id from public.events where slug='${E_TOKEN_ONLY}'),  '${T_TOK}'::uuid, 't23x tok', null,    null),
         ((select id from public.events where slug='${E_FOREIGN}'),     '${T_FOR}'::uuid, 't23x for', null,    '${hostB.id}'),
         ((select id from public.events where slug='${E_FULL}'),        '${T_FS_GO}'::uuid,'t23x go', '${C_GO}', null),
         ((select id from public.events where slug='${E_FULL}'),        '${T_FS_MB}'::uuid,'t23x mb', '${C_MB}', null),
         ((select id from public.events where slug='${E_FULL}'),        '${T_FS_NG}'::uuid,'t23x ng', '${C_NG}', null),
         ((select id from public.events where slug='${E_FULL}'),        '${T_FS_WL}'::uuid,'t23x wl', '${C_WL}', null);`,
    );

    // RSVP statuses by token: the full-status event gets one of each; every other
    // attend-branch row is 'going' (an unlocking status).
    runSql(
      `insert into public.rsvps (event_id, guest_id, status)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_FS_MB}'::uuid then 'maybe'
             when '${T_FS_NG}'::uuid then 'not_going'
             when '${T_FS_WL}'::uuid then 'waitlisted'
             else 'going'
           end
         from public.guests g
         where g.event_id in (select id from public.events where slug like '${PREFIX}%');`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where slug like '${PREFIX}%';`);
  });

  // ── 1) FIELD-LEVEL LEAK — the part parseMyEvents would have hidden ──────────
  it.skipIf(!LOCAL_UP)(
    "get_my_events emits ONLY first-tier keys — no contact/location_text/host_id/password/user_id, raw",
    async () => {
      const feed = await rawFeed(hostA);
      expect(feed.length, "A has seeded events to inspect").toBeGreaterThan(0);

      for (const rowObj of feed) {
        const keys = Object.keys(rowObj);
        for (const banned of BANNED_FEED_KEYS) {
          expect(keys, `row leaked a banned key: ${banned}`).not.toContain(banned);
        }
        for (const k of keys) {
          expect(ALLOWED_FEED_KEYS.has(k), `unexpected feed key: ${k}`).toBe(true);
        }
      }
    },
  );

  it.skipIf(!LOCAL_UP)(
    "the full street address (location_text) and host-only contacts never appear in the feed body",
    async () => {
      const feed = await rawFeed(hostA);
      const slugs = slugsOf(feed);
      // The events themselves ARE mine and present…
      expect(slugs, "my host-attend event is in the feed").toContain(E_HOST_ATTEND);
      expect(slugs, "my full-status event is in the feed").toContain(E_FULL);

      // …but the second-tier address and the host-only contacts must not be in the body.
      const body = JSON.stringify(feed);
      expect(body, "full address (location_text) leaked into the feed").not.toContain(ADDR_SENTINEL);
      for (const contact of [C_GO, C_MB, C_NG, C_WL]) {
        expect(body, `a guest contact (${contact}) leaked into the feed`).not.toContain(contact);
      }

      // City level (first tier) is allowed and should be what's exposed instead.
      const ha = feed.find((r) => r.slug === E_HOST_ATTEND);
      expect(ha?.location_city, "city-level location is the first-tier field shown").toBe("Testville");
    },
  );

  // ── 2) ATTEND-BRANCH SCOPE (D1) — keyed on guests.user_id, never token/existence ─
  it.skipIf(!LOCAL_UP)(
    "an event I attend only via a token-only (user_id NULL) row does NOT enter my feed; B (the host) DOES see it",
    async () => {
      const aSlugs = slugsOf(await rawFeed(hostA));
      expect(aSlugs, "token-only attendance must not link to my account").not.toContain(E_TOKEN_ONLY);

      // Prove the event is REAL (exclusion is scoping, not absence): B hosts it.
      const bFeed = await rawFeed(hostB);
      const bRow = bFeed.find((r) => r.slug === E_TOKEN_ONLY);
      expect(bRow, "B's own event exists and is in B's feed").toBeTruthy();
      expect(bRow?.role, "B is the host of it").toBe("host");
    },
  );

  it.skipIf(!LOCAL_UP)(
    "an event whose guest row is linked to ANOTHER account (host B) does NOT enter my feed",
    async () => {
      const aSlugs = slugsOf(await rawFeed(hostA));
      expect(aSlugs, "a foreign user_id must not surface as MY attendance").not.toContain(E_FOREIGN);

      const bSlugs = slugsOf(await rawFeed(hostB));
      expect(bSlugs, "B hosts E_FOREIGN so it's in B's feed").toContain(E_FOREIGN);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "a PRIVATE event I genuinely attend (guests.user_id=me) DOES surface, role='guest' (feed must not over-filter)",
    async () => {
      const feed = await rawFeed(hostA);
      const row = feed.find((r) => r.slug === E_PRIV_ATTEND);
      expect(row, "my attended private event must appear in my feed").toBeTruthy();
      expect(row?.role, "I'm an attendee, not the host").toBe("guest");
      expect(row?.visibility, "it is private — surfaced because I'm in it, not made public").toBe("private");
    },
  );

  it.skipIf(!LOCAL_UP)(
    "an event I both host AND attend appears EXACTLY ONCE, role='host' (D9 authority + dedup)",
    async () => {
      const feed = await rawFeed(hostA);
      const matches = feed.filter((r) => r.slug === E_HOST_ATTEND);
      expect(matches.length, "host∪attend must not duplicate the event row").toBe(1);
      expect(matches[0]?.role, "host_id is the authority even when I also have a guest row").toBe("host");
    },
  );

  // ── 3) anon → get_my_events leaks no events ─────────────────────────────────
  it.skipIf(!LOCAL_UP)("anon calling get_my_events leaks nobody's events (empty / denied, never rows)", async () => {
    const { data, error } = await anonClient().rpc("get_my_events");
    // Whether anon is ungranted (error) or granted-but-null-uid (returns []), the
    // security property is identical: no event rows come back.
    const rows = error ? [] : Array.isArray(data) ? data : [];
    expect(rows, "anon must receive zero events from get_my_events").toEqual([]);
  });

  // ── 4) HOST DETAIL DATA PATH — full-list visibility + RLS isolation ─────────
  it.skipIf(!LOCAL_UP)(
    "owning host reads ALL four statuses incl not_going + waitlisted (第三类) with contact (M1)",
    async () => {
      const eventId = runSql(`select id from public.events where slug='${E_FULL}';`).trim();

      const res = await hostClient(hostA)
        .from("rsvps")
        .select("status, plus_ones, guests(display_name, contact)")
        .eq("event_id", eventId);
      expect(res.error, JSON.stringify(res.error)).toBeNull();

      const rows = (res.data ?? []) as unknown as Array<{
        status: string;
        guests: { display_name: string; contact: string | null } | null;
      }>;

      const statuses = new Set(rows.map((r) => r.status));
      // A guest's get_guest_list returns only going/maybe; the HOST detail view must
      // additionally surface the Can't-Go and waitlist rows (third-tier, host-only).
      for (const s of ["going", "maybe", "not_going", "waitlisted"]) {
        expect(statuses, `host detail must include status '${s}'`).toContain(s);
      }

      const contacts = rows.map((r) => r.guests?.contact);
      for (const c of [C_GO, C_MB, C_NG, C_WL]) {
        expect(contacts, `host sees the host-only contact ${c} (M1)`).toContain(c);
      }
    },
  );

  it.skipIf(!LOCAL_UP)(
    "the detail page's FIRST query (the events row) is RLS-isolated: owner reads it, non-owner host and anon get null",
    async () => {
      const eventId = runSql(`select id from public.events where slug='${E_FULL}';`).trim();

      // Owner: the exact query HostEventDetailPage runs first.
      const owner = await hostClient(hostA)
        .from("events")
        .select("id, slug, title, status, visibility, starts_at, date_tbd, capacity")
        .eq("id", eventId)
        .maybeSingle();
      expect(owner.error, JSON.stringify(owner.error)).toBeNull();
      expect(owner.data?.id, "owner host loads their own event row").toBe(eventId);

      // Non-owner host: RLS (USING host_id = auth.uid()) yields no row → notFound().
      const nonOwner = await hostClient(hostB)
        .from("events")
        .select("id")
        .eq("id", eventId)
        .maybeSingle();
      expect(nonOwner.data, "a non-owner host must NOT read another host's event row").toBeNull();

      // Anon: no policy/grant on events at all (G1) → no row.
      const an = await anonClient().from("events").select("id").eq("id", eventId).maybeSingle();
      expect(an.data, "anon must NOT read the event row directly").toBeNull();
    },
  );

  it.skipIf(!LOCAL_UP)(
    "a non-owner host and anon read NONE of the owner's rsvps/guests (contact unreachable off the host path)",
    async () => {
      const eventId = runSql(`select id from public.events where slug='${E_FULL}';`).trim();

      const nonOwner = await hostClient(hostB)
        .from("rsvps")
        .select("status, guests(contact)")
        .eq("event_id", eventId);
      expect(nonOwner.error, JSON.stringify(nonOwner.error)).toBeNull();
      expect((nonOwner.data ?? []).length, "non-owner host reads none of A's rsvps").toBe(0);

      const an = await anonClient().from("rsvps").select("status, guests(contact)").eq("event_id", eventId);
      expect((an.data ?? []).length, "anon reads nothing from rsvps/guests directly (G1)").toBe(0);

      // And straight at the guests table: anon never reaches contact.
      const anGuests = await anonClient().from("guests").select("contact").eq("event_id", eventId);
      expect((anGuests.data ?? []).length, "anon reads nothing from guests directly").toBe(0);
    },
  );
});
