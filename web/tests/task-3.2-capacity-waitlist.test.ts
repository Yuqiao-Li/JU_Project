import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";
import { goingOccupancy, remainingSpots, spotsLeftLabel } from "../lib/events/capacity";

/**
 * Task 3.2 — capacity + waitlist UX (TASKS.md §3.2).
 *
 * 3.2 has NO new RPC: it RENDERS the capacity numbers (get_event_by_slug's
 * going_count/capacity_remaining) as "还剩 X 位 / 已满—等待名单", clearly labels the
 * waitlist, and gives the HOST a single waitlist column with a manual "promote"
 * control that calls the existing host-only promote_guest RPC (1.5e / 0011). So the new
 * surface is two things — a small pure presentation boundary and the host promote wiring
 * — asserted where each actually lives:
 *
 *  A. THE PURE CAPACITY BOUNDARY (web/lib/events/capacity.ts). remainingSpots /
 *     goingOccupancy / spotsLeftLabel are the single source of the "X spots left /
 *     Full — join the waitlist" copy and the host's remaining-seat math. Pure (no DB,
 *     no server-only, no React), so they're hammered directly: no-limit ⇒ no chip,
 *     clamp-at-zero (never a negative headcount), exact singular/plural copy, and an
 *     occupancy count that only ever sums GOING heads incl. +1s.
 *
 *  B. THE WIRING (static source guard). vitest can't render these React server/client
 *     trees (server-only + @/-alias make them un-importable — see the harness notes),
 *     and the security-bearing invariant here is STRUCTURAL: the host promote must run
 *     in the HOST's own auth context (promote_guest is gated on auth.uid() = host_id,
 *     D7③) — NEVER the service role — and the public capacity line must flow from the
 *     one tested helper. So it's asserted on source text: the action calls promote_guest
 *     through the host client and never touches the trusted role; the page renders the
 *     promote control in its waitlist column; the public view draws its line from
 *     spotsLeftLabel.
 *
 *  C. THE DATA PATH (RPC boundary, real host session). The deliverable's named test —
 *     "promote_guest 改 going 且尊重容量". Driven through the SAME host-authed RPC call
 *     the action makes: the owning host promotes a waitlisted guest that fits ⇒ going;
 *     a promote that would oversell is refused and the guest stays waitlisted; and a
 *     non-host (anon) call can never promote. (0011 covers the RPC in isolation; this
 *     pins the host-context path the 3.2 UI actually drives.)
 *
 * Block C is gated on a reachable local stack so the file skips green without Docker;
 * blocks A and B are pure/static and ALWAYS run. Seeding is done as the postgres
 * superuser (psql) since anon/service hold no direct table grant — same pattern as the
 * 3.1 / 1.5x suites. Fixtures are isolated by the per-file `t32` prefix.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Block A — the pure capacity/waitlist presentation boundary (always runs, no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe("task 3.2 A: the pure capacity boundary computes seats + copy correctly (TASKS.md §3.2)", () => {
  it("remainingSpots: no capacity limit ⇒ null (nothing to show); otherwise clamps to a non-negative count", () => {
    expect(remainingSpots(null, 5), "null capacity = unlimited ⇒ no remaining figure").toBeNull();
    expect(remainingSpots(undefined, 5), "undefined capacity ⇒ no remaining figure").toBeNull();
    expect(remainingSpots(10, 3), "10 - 3 = 7 left").toBe(7);
    expect(remainingSpots(5, 5), "exactly full ⇒ 0 left").toBe(0);
    // Over capacity (a host shrank the cap below the headcount) NEVER shows negative.
    expect(remainingSpots(5, 9), "over capacity clamps to 0, never negative").toBe(0);
  });

  it("spotsLeftLabel: 还剩 X 位 / 已满—等待名单 — null when unbounded, the waitlist line at/below 0, exact singular/plural otherwise", () => {
    expect(spotsLeftLabel(null), "no limit ⇒ no chip").toBeNull();
    expect(spotsLeftLabel(undefined), "unknown ⇒ no chip").toBeNull();
    expect(spotsLeftLabel(0), "full ⇒ waitlist framing").toBe("Full — join the waitlist");
    // Defensive: a stray negative still reads as full, never "-2 spots left".
    expect(spotsLeftLabel(-2), "negative still reads as full").toBe("Full — join the waitlist");
    expect(spotsLeftLabel(1), "singular").toBe("1 spot left");
    expect(spotsLeftLabel(3), "plural").toBe("3 spots left");
    expect(spotsLeftLabel(12), "plural, larger").toBe("12 spots left");
  });

  it("goingOccupancy: counts ONLY going heads incl. +1s — maybe / not_going / waitlisted never occupy a seat", () => {
    const rows = [
      { status: "going", plus_ones: 2 }, // 3 heads
      { status: "going", plus_ones: 0 }, // 1 head
      { status: "maybe", plus_ones: 5 }, // ignored
      { status: "not_going", plus_ones: 1 }, // ignored
      { status: "waitlisted", plus_ones: 4 }, // ignored — a waitlisted guest holds no seat
    ];
    expect(goingOccupancy(rows), "(1+2)+(1+0) = 4; non-going rows excluded").toBe(4);
    expect(goingOccupancy([]), "empty ⇒ 0").toBe(0);
    // A garbled negative / null +1 never subtracts from the count.
    expect(
      goingOccupancy([{ status: "going", plus_ones: -3 }, { status: "going", plus_ones: null }]),
      "negative/null +1 floors to the lone head: 1 + 1 = 2",
    ).toBe(2);
  });

  it("the capacity chip and the host stat agree: spotsLeftLabel(remainingSpots(cap, occ)) reflects the same seats", () => {
    // capacity 4, two going (one +1) ⇒ occupancy 3 ⇒ 1 left ⇒ singular.
    const occ = goingOccupancy([
      { status: "going", plus_ones: 1 },
      { status: "going", plus_ones: 0 },
    ]);
    expect(occ, "occupancy = 3").toBe(3);
    const left = remainingSpots(4, occ);
    expect(left, "1 seat left").toBe(1);
    expect(spotsLeftLabel(left), "renders the singular line").toBe("1 spot left");
    // One more going guest ⇒ full ⇒ the waitlist line.
    expect(spotsLeftLabel(remainingSpots(4, occ + 1)), "now full").toBe("Full — join the waitlist");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block B — the wiring: host-context promote (never service role); single copy source
// ─────────────────────────────────────────────────────────────────────────────

/** Read an implementation source file by repo-relative path (relative to this test). */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

/** A reference to the trusted/service role — forbidden in the promote action. */
const SERVICE_ROLE_REF = /service[_-]?role|createServiceClient|serviceClient|lib\/supabase\/service/i;

describe("task 3.2 B: the host promote runs in the host's auth context (never the trusted role); the capacity copy has ONE source (TASKS.md §3.2)", () => {
  const EVENT_VIEW = src("app/[slug]/event-view.tsx");
  const HOST_PAGE = src("app/dashboard/events/[id]/page.tsx");
  const ACTIONS = src("app/dashboard/events/[id]/actions.ts");
  const PROMOTE_BTN = src("app/dashboard/events/[id]/promote-button.tsx");

  it("the public capacity line flows from the single pure helper (spotsLeftLabel), not an inline ad-hoc string", () => {
    expect(EVENT_VIEW, "event-view renders the chip via spotsLeftLabel").toContain("spotsLeftLabel");
    expect(EVENT_VIEW, "…imported from the shared capacity module").toMatch(/lib\/events\/capacity/);
  });

  it("the host detail page derives its seat math from the shared helper and renders a promote control in its waitlist column", () => {
    expect(HOST_PAGE, "host page uses the shared remaining-seat helper").toMatch(
      /remainingSpots|goingOccupancy/,
    );
    expect(HOST_PAGE, "host page has a waitlist column").toMatch(/waitlist/i);
    expect(HOST_PAGE, "host page renders the promote control").toContain("PromoteButton");
  });

  it("the promote SERVER ACTION calls the host-only promote_guest RPC through the HOST's own client — never the service role", () => {
    expect(ACTIONS, "it's a server action").toMatch(/["']use server["']/);
    expect(ACTIONS, "calls the host-only RPC").toContain("promote_guest");
    // The host auth client (lib/supabase/server) — promote_guest is gated on
    // auth.uid() = host_id (D7③), so it MUST run as the host, not the trusted role.
    expect(ACTIONS, "goes through the host's authed server client").toMatch(/lib\/supabase\/server/);
    expect(ACTIONS, "re-checks the session (server actions are POST-reachable)").toContain(
      "auth.getUser",
    );
    expect(
      SERVICE_ROLE_REF.test(ACTIONS),
      "the promote action must NEVER reach for the service/trusted role (would bypass the host gate)",
    ).toBe(false);
    expect(ACTIONS, "revalidates the page so the moved guest reflects immediately").toContain(
      "revalidatePath",
    );
  });

  it("the promote button is a client control wired to the promoteGuest action with the rsvp/event identifiers", () => {
    expect(PROMOTE_BTN, "client component").toMatch(/["']use client["']/);
    expect(PROMOTE_BTN, "wired to the promote action").toContain("promoteGuest");
    expect(PROMOTE_BTN, "carries the rsvp id to the action").toContain("rsvp_id");
    expect(PROMOTE_BTN, "carries the event id to the action").toContain("event_id");
    // The button itself never reaches for the trusted role either.
    expect(SERVICE_ROLE_REF.test(PROMOTE_BTN), "promote button holds no service-role reference").toBe(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block C — the data path: promote_guest over a REAL host session (DB-backed)
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_UP = localStackRunning();
const FN_PROMOTE = "promote_guest";

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

type ApiResult = { data: unknown; error: { message?: string } | null };

// ── Fixtures (t32 prefix).
const PREFIX = "t32";
const E_ROOM = "t32-room"; // capacity 3, occupancy 2 ⇒ 1 seat for the waitlisted guest
const E_FULL = "t32-full"; // capacity 2, occupancy 2 ⇒ no seat: promote must be refused

const T_ROOM_W = "32000000-0000-4000-8000-000000000001"; // E_ROOM waitlisted — promotable
const T_FULL_W = "32000000-0000-4000-8000-000000000002"; // E_FULL waitlisted — capacity-blocked

describe("task 3.2 C: promote_guest over the host's session — waitlist → going, capacity respected (TASKS.md §3.2)", () => {
  const i = infra();
  const hostA = i.hosts[0];

  function anon(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  /** The host's own authed client — exactly what the promote server action uses. */
  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  /** Resolve the rsvp id for a deterministic guest token. */
  function rsvpIdByToken(token: string): string {
    return scalar(
      runSql(
        `select r.id from public.rsvps r
           join public.guests g on g.id = r.guest_id
          where g.guest_token = '${token}'::uuid;`,
      ),
    );
  }

  /** Read back an rsvp's current status (superuser, bypasses RLS). */
  function statusByToken(token: string): string {
    return scalar(
      runSql(
        `select r.status from public.rsvps r
           join public.guests g on g.id = r.guest_id
          where g.guest_token = '${token}'::uuid;`,
      ),
    );
  }

  async function callPromote(client: SupabaseClient, rsvpId: string): Promise<ApiResult> {
    return (await client.rpc(FN_PROMOTE, { rsvp_id: rsvpId })) as ApiResult;
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();

    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't32 host A') on conflict (id) do nothing;`,
    );

    // E_ROOM: capacity 3 with 2 going heads (room for 1). E_FULL: capacity 2, 2 going (full).
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, capacity, allow_plus_ones, max_plus_ones) values
         ('${hostA.id}','${E_ROOM}','t32 room','public','published', 3, true, 3),
         ('${hostA.id}','${E_FULL}','t32 full','public','published', 2, true, 3);`,
    );

    // Occupants (going) + the one waitlisted guest per event. Deterministic tokens for the
    // waitlisted rows so we can resolve their rsvp id; occupants use random tokens.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name) values
         ((select id from public.events where slug='${E_ROOM}'), gen_random_uuid(), 't32-room-go1'),
         ((select id from public.events where slug='${E_ROOM}'), gen_random_uuid(), 't32-room-go2'),
         ((select id from public.events where slug='${E_ROOM}'), '${T_ROOM_W}'::uuid, 't32-room-wait'),
         ((select id from public.events where slug='${E_FULL}'), gen_random_uuid(), 't32-full-go1'),
         ((select id from public.events where slug='${E_FULL}'), gen_random_uuid(), 't32-full-go2'),
         ((select id from public.events where slug='${E_FULL}'), '${T_FULL_W}'::uuid, 't32-full-wait');`,
    );

    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case when g.display_name like '%-wait' then 'waitlisted' else 'going' end,
           0
         from public.guests g
         where g.display_name like 't32-%';`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  it.skipIf(!LOCAL_UP)(
    "the owning host promotes a waitlisted guest that FITS capacity ⇒ status becomes 'going'",
    async () => {
      expect(statusByToken(T_ROOM_W), "starts waitlisted").toBe("waitlisted");
      const r = await callPromote(asHost(hostA.accessToken), rsvpIdByToken(T_ROOM_W));
      expect(r.error, JSON.stringify(r.error)).toBeNull();
      expect(statusByToken(T_ROOM_W), "promoted into the open seat ⇒ going").toBe("going");
    },
  );

  it.skipIf(!LOCAL_UP)(
    "promote_guest RESPECTS capacity: promoting into a full event is refused and the guest stays waitlisted (尊重容量)",
    async () => {
      expect(statusByToken(T_FULL_W), "starts waitlisted").toBe("waitlisted");
      const r = await callPromote(asHost(hostA.accessToken), rsvpIdByToken(T_FULL_W));
      expect(r.error, "promoting past capacity ⇒ refused").not.toBeNull();
      expect(r.error?.message, "the refusal names capacity").toMatch(/capacit/i);
      expect(statusByToken(T_FULL_W), "still waitlisted — no oversell").toBe("waitlisted");
    },
  );

  it.skipIf(!LOCAL_UP)(
    "a NON-host (anon, no host JWT) can never promote — the host gate (auth.uid() = host_id) holds; the guest stays waitlisted",
    async () => {
      // Re-seed a fresh waitlisted row on E_FULL is unnecessary — T_FULL_W is still waitlisted.
      const r = await callPromote(anon(), rsvpIdByToken(T_FULL_W));
      expect(r.error, "anon promote ⇒ rejected").not.toBeNull();
      expect(statusByToken(T_FULL_W), "anon path changed nothing").toBe("waitlisted");
    },
  );
});
