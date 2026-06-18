import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Round-3 #6 [SECURITY] — `get_public_events()`, the site-wide DISCOVERY read path
 * (migration 0020_get_public_events.sql). Written by the INDEPENDENT test agent
 * (never wrote the implementation), stance "assume this function over-shares".
 *
 * This one DEFINER function is the ONLY way the public `/discover` page learns
 * which events exist site-wide — anon has NO direct grant on `events` (G1). So a
 * single missing branch here leaks a private/draft/cancelled event's existence to
 * the entire internet, or rides a full street address (location_text, second tier)
 * along on a card that should carry only first-tier façade fields. The pinned
 * contract (0020 header + CLAUDE.md "first-tier façade only / no existence oracle
 * for non-public events"):
 *
 *   1. INCLUDES a public+published event (with a real location_text/address set).
 *   2. EXCLUDES private+published, public+draft, public+cancelled — by slug/title.
 *   3. GLOBAL across hosts: host B's public+published event also appears in host
 *      A's anon call — it's site-wide, not host-scoped.
 *   4. FIRST-TIER ONLY — NO leak: the included row carries title/slug/location_city/
 *      host_display_name, and NEVER location_text (the address) nor any guest-list /
 *      contact / token / hash key. The address string is ABSENT from the whole
 *      JSON.stringify(result) — the strongest leak check.
 *   5. host_display_name is the host's public profile display_name.
 *   6. anon can EXECUTE it (the call succeeds with the anon key, no permission error).
 *
 * Events are inserted through the HOST's own authenticated PostgREST client — the
 * events RLS WITH CHECK (host_id = auth.uid()) lets a host insert their own rows —
 * so the seed path is the real one a host hits. The RPC is then called over the
 * ANON wire (auth.role()='anon'), which is the exact path the public page uses.
 * The host profile display_name is set / teardown done as the postgres superuser
 * (psql), matching the sibling DB suites (task-6.1 / 1.5a). Gated on a reachable
 * local stack so the file skips green without Docker.
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

type ApiResult = { data: unknown; error: unknown };
type EventObj = Record<string, unknown>;

const FN = "get_public_events";

// ── Sentinels — unique enough to prove a specific value never crosses a boundary.
const PREFIX = "t0020";
const SLUG_PUB = "t0020-public-published"; // host A — MUST appear
const SLUG_PRIV = "t0020-private-published"; // host A — must NOT appear
const SLUG_DRAFT = "t0020-public-draft"; // host A — must NOT appear
const SLUG_CANCELLED = "t0020-public-cancelled"; // host A — must NOT appear
const SLUG_PUB_B = "t0020-public-host-b"; // host B — MUST appear (global, not host-scoped)

const TITLE_PUB = "t0020 Public Published";
const TITLE_PRIV = "t0020 Private Published";
const TITLE_DRAFT = "t0020 Public Draft";
const TITLE_CANCELLED = "t0020 Public Cancelled";
const TITLE_PUB_B = "t0020 Public Host B";

// The full street address set on EVERY seeded event. A first-tier discovery card
// must never carry it — its presence anywhere in the payload is an unambiguous leak.
const SENTINEL_ADDR = "t0020-FULL-ADDRESS-99-Discovery-Lane-SENTINEL";
const CITY = "t0020-Brooklyn"; // location_city — first tier, MAY appear.
const HOST_A_DISPLAY = "t0020 Host A Display";

/** Own-key check that doesn't trip on inherited props. */
function hasKey(obj: EventObj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

describe("migration 0020 [SECURITY]: get_public_events site-wide discovery read path", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

  function anon(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  /** Authenticated host path — caller's JWT, so RLS WITH CHECK (host_id=auth.uid()) applies. */
  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  /** Call get_public_events over the anon wire; return the parsed jsonb array. */
  async function callDiscover(client: SupabaseClient): Promise<{ res: ApiResult; rows: EventObj[] }> {
    const res = (await client.rpc(FN)) as ApiResult;
    const rows = (Array.isArray(res.data) ? res.data : []) as EventObj[];
    return { res, rows };
  }

  beforeAll(async () => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need host A session").toBeTruthy();
    expect(hostB?.id, "need host B session (the global-across-hosts branch)").toBeTruthy();

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where slug like '${PREFIX}%';`);

    // Host A gets a recognizable public display_name so bullet 5 can assert it.
    runSql(
      `update public.profiles set display_name='${HOST_A_DISPLAY}' where id='${hostA.id}';`,
    );

    // Insert through the HOST's own authenticated client — the real seed path
    // (events RLS WITH CHECK host_id = auth.uid()). Every event carries the SAME
    // sentinel address/city so a leak is unambiguous.
    const baseA = {
      host_id: hostA.id,
      description: "t0020 desc",
      cover_image_url: "https://cover/t0020.png",
      starts_at: "2030-01-01T18:00:00+00:00",
      date_tbd: false,
      location_text: SENTINEL_ADDR,
      location_city: CITY,
    };
    const insA = await asHost(hostA.accessToken)
      .from("events")
      .insert([
        { ...baseA, slug: SLUG_PUB, title: TITLE_PUB, visibility: "public", status: "published" },
        { ...baseA, slug: SLUG_PRIV, title: TITLE_PRIV, visibility: "private", status: "published" },
        { ...baseA, slug: SLUG_DRAFT, title: TITLE_DRAFT, visibility: "public", status: "draft" },
        {
          ...baseA,
          slug: SLUG_CANCELLED,
          title: TITLE_CANCELLED,
          visibility: "public",
          status: "cancelled",
        },
      ]);
    expect(insA.error, `host A insert: ${JSON.stringify(insA.error)}`).toBeNull();

    // Host B's public+published event — to prove the list is site-wide, not host-scoped.
    const insB = await asHost(hostB.accessToken)
      .from("events")
      .insert([
        {
          host_id: hostB.id,
          slug: SLUG_PUB_B,
          title: TITLE_PUB_B,
          description: "t0020 host b desc",
          cover_image_url: "https://cover/t0020b.png",
          starts_at: "2030-02-02T18:00:00+00:00",
          date_tbd: false,
          location_text: SENTINEL_ADDR,
          location_city: CITY,
          visibility: "public",
          status: "published",
        },
      ]);
    expect(insB.error, `host B insert: ${JSON.stringify(insB.error)}`).toBeNull();
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    // Delete the rows we inserted (by our slug prefix) so the other DB suites that
    // run after us see a clean events table even within a single db-reset window.
    runSql(`delete from public.events where slug like '${PREFIX}%';`);
  });

  // ── bullet 6 (run first — everything else depends on it) — anon may EXECUTE ──────
  it.skipIf(!LOCAL_UP)("anon can EXECUTE get_public_events (no permission error)", async () => {
    const { res, rows } = await callDiscover(anon());
    expect(res.error, `anon must be granted EXECUTE: ${JSON.stringify(res.error)}`).toBeNull();
    expect(Array.isArray(res.data), "returns a jsonb array").toBe(true);
    expect(rows.length, "the seeded public events make the list non-empty").toBeGreaterThanOrEqual(2);
  });

  // ── bullet 1 — INCLUDES the public+published event ───────────────────────────────
  it.skipIf(!LOCAL_UP)("includes a public+published event (with a real address set on it)", async () => {
    const { res, rows } = await callDiscover(anon());
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    const slugs = rows.map((r) => String(r.slug));
    expect(slugs, "the public+published event appears in discovery").toContain(SLUG_PUB);
    const titles = rows.map((r) => String(r.title));
    expect(titles, "…by its recognizable title too").toContain(TITLE_PUB);
  });

  // ── bullet 2 — EXCLUDES private, draft, cancelled (by slug AND title) ─────────────
  it.skipIf(!LOCAL_UP)(
    "excludes private+published, public+draft, and public+cancelled events",
    async () => {
      const { rows } = await callDiscover(anon());
      const slugs = rows.map((r) => String(r.slug));
      const titles = rows.map((r) => String(r.title));

      expect(slugs, "a PRIVATE event never surfaces in discovery").not.toContain(SLUG_PRIV);
      expect(slugs, "a DRAFT event never surfaces").not.toContain(SLUG_DRAFT);
      expect(slugs, "a CANCELLED event never surfaces").not.toContain(SLUG_CANCELLED);

      // Title check too — a non-public event must not be an existence oracle by any field.
      expect(titles).not.toContain(TITLE_PRIV);
      expect(titles).not.toContain(TITLE_DRAFT);
      expect(titles).not.toContain(TITLE_CANCELLED);
    },
  );

  // ── bullet 3 — GLOBAL across hosts: host A's anon call sees host B's event too ────
  it.skipIf(!LOCAL_UP)(
    "is site-wide: an anon call sees BOTH host A's and host B's public+published events",
    async () => {
      const { rows } = await callDiscover(anon());
      const slugs = rows.map((r) => String(r.slug));
      expect(slugs, "host A's public event appears").toContain(SLUG_PUB);
      expect(slugs, "host B's public event ALSO appears (global, not host-scoped)").toContain(
        SLUG_PUB_B,
      );
    },
  );

  // ── bullet 4 — FIRST-TIER ONLY: address/guest-list/contact/token never leak ──────
  it.skipIf(!LOCAL_UP)(
    "the included event carries first-tier façade fields only — NO location_text/address, contact, token, or hash",
    async () => {
      const { res, rows } = await callDiscover(anon());
      const pub = rows.find((r) => String(r.slug) === SLUG_PUB);
      expect(pub, "the public event row is present").toBeTruthy();
      const row = pub as EventObj;

      // First-tier fields ARE present.
      expect(row.title, "title is first tier").toBe(TITLE_PUB);
      expect(row.slug).toBe(SLUG_PUB);
      expect(row.location_city, "city-level is first tier").toBe(CITY);
      expect(hasKey(row, "host_display_name"), "host_display_name is part of the card").toBe(true);

      // The full address must be NOWHERE in the payload — strongest leak check.
      expect(
        JSON.stringify(res.data),
        "the full street address (location_text) must never ride along in discovery",
      ).not.toContain(SENTINEL_ADDR);

      // …and the address key itself is absent on the row.
      expect(hasKey(row, "location_text"), "no location_text (address) key on a discovery card").toBe(
        false,
      );
      expect(hasKey(row, "location_url"), "no venue url key either").toBe(false);

      // No guest-list / contact / token / hash field rides along, on ANY row.
      for (const r of rows) {
        expect(hasKey(r, "contact"), "contact must never appear").toBe(false);
        expect(hasKey(r, "guest_token"), "no guest token in discovery").toBe(false);
        expect(hasKey(r, "view_password_hash"), "no password hash in discovery").toBe(false);
        expect(hasKey(r, "going_count"), "no occupancy/guest-list signal in discovery").toBe(false);
        expect(hasKey(r, "host_id"), "no raw host_id (internal) on a public card").toBe(false);
      }
    },
  );

  // ── bullet 5 — host_display_name is the host's public profile display_name ───────
  it.skipIf(!LOCAL_UP)(
    "host_display_name is present and is the host's public display name (string | null)",
    async () => {
      const { rows } = await callDiscover(anon());
      const pub = rows.find((r) => String(r.slug) === SLUG_PUB) as EventObj | undefined;
      expect(pub, "the public event row is present").toBeTruthy();
      const dn = (pub as EventObj).host_display_name;
      // We set host A's display_name above, so it must be exactly that.
      expect(dn, "host_display_name reflects the host's profile display_name").toBe(HOST_A_DISPLAY);

      // Across all rows the key is present and is string|null (never an object/leak).
      for (const r of rows) {
        const v = r.host_display_name;
        expect(
          v === null || typeof v === "string",
          `host_display_name must be string|null, got ${typeof v}`,
        ).toBe(true);
      }
    },
  );
});

// ── JOB 2 — SOURCE / CONFIG GUARDS (always run; no DB) ───────────────────────────
//
// The /discover page is an `async` Server Component (server-only getTranslations,
// Supabase server client) — it does not execute under this vitest harness — so its
// PUBLIC-ness and the login-gated create button are pinned by comment-stripped
// SOURCE-GREP, the same style as auth-round3-batch-b / client-tree-no-server-getTranslations.
// The i18n parity check guards the discover namespace + home.browseEvents in BOTH locales.

/** Read a file under `web/` by web-relative path (relative to this test file's dir). */
function webSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

/** Strip block + line comments so we grep CODE, not prose that names our tokens. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (preserve char before "//", spares "https://")
}

describe("migration 0020 [guard]: /discover page is PUBLIC, create button is login-gated", () => {
  const REL = "app/discover/page.tsx";

  it("the discover page file exists where the test expects it", () => {
    expect(existsSync(fileURLToPath(new URL(`../${REL}`, import.meta.url))), `${REL} must exist`).toBe(
      true,
    );
  });

  it("viewing is PUBLIC — no redirect() to login/dashboard anywhere in the page code", () => {
    const code = stripComments(webSrc(REL));
    // A redirect to a private destination would gate VIEWING — forbidden on a public page.
    expect(/redirect\s*\(\s*['"`]\/login/.test(code), "must not redirect viewers to /login").toBe(
      false,
    );
    expect(
      /redirect\s*\(\s*['"`]\/dashboard/.test(code),
      "must not redirect viewers to /dashboard",
    ).toBe(false);
    // No bare redirect() at all — the page must render for everyone.
    expect(/\bredirect\s*\(/.test(code), "the public discovery page must not call redirect()").toBe(
      false,
    );
  });

  it("the create button is login-gated: /dashboard/events/new for a user, /login?next= otherwise", () => {
    const code = stripComments(webSrc(REL));
    expect(code, "the create destination references the create form").toContain(
      "/dashboard/events/new",
    );
    expect(/\/login\?next=/.test(code), "an absent user falls back to /login?next=").toBe(true);
    // The branch is keyed on the user being present/absent (getUser → user ? … : …).
    expect(/getUser\s*\(/.test(code), "the page reads the auth user to pick the create href").toBe(
      true,
    );
    expect(/\buser\b\s*\?/.test(code), "the create href is a user-conditional ternary").toBe(true);
  });
});

describe("migration 0020 [guard]: i18n parity for the discover namespace + home.browseEvents", () => {
  const zh = JSON.parse(webSrc("messages/zh.json")) as Record<string, Record<string, unknown>>;
  const en = JSON.parse(webSrc("messages/en.json")) as Record<string, Record<string, unknown>>;

  it("both locales define a non-empty `discover` namespace with identical key sets", () => {
    expect(zh.discover, "zh has a discover namespace").toBeTruthy();
    expect(en.discover, "en has a discover namespace").toBeTruthy();
    const zhKeys = Object.keys(zh.discover).sort();
    const enKeys = Object.keys(en.discover).sort();
    expect(zhKeys.length, "discover namespace is non-empty").toBeGreaterThan(0);
    expect(zhKeys, "zh and en discover key sets are identical").toEqual(enKeys);
  });

  it("home.browseEvents exists (non-empty string) in both locales", () => {
    const zhVal = (zh.home as Record<string, unknown> | undefined)?.browseEvents;
    const enVal = (en.home as Record<string, unknown> | undefined)?.browseEvents;
    expect(typeof zhVal === "string" && zhVal.length > 0, "zh.home.browseEvents present").toBe(true);
    expect(typeof enVal === "string" && enVal.length > 0, "en.home.browseEvents present").toBe(true);
  });
});
