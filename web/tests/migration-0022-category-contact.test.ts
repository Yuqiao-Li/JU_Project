import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Step-10A Task 1 [SECURITY] — the 成局 DB foundation (migration
 * 0022_category_cardvariant_hostcontact.sql). Written by the INDEPENDENT test agent
 * (did NOT write the implementation), treating the migration as a BLACK BOX. Mirrors
 * the 0021 harness exactly: it.skipIf(!LOCAL_UP), anon + service-role PostgREST .rpc
 * against the LOCAL supabase DB, psql superuser seeding (auto-expose OFF ⇒ only the
 * DEFINER RPCs or psql can seed events/guests/rsvps).
 *
 * 0022 makes three additive changes to the deployed interface, every other field /
 * tier / gate copied byte-faithful from 0021 / 0020:
 *
 *   1. get_event_by_slug now ALWAYS returns 'category' + 'card_variant' on the
 *      first-tier façade — non-sensitive public card art, present even PRE-LOCK and
 *      to an anon passerby.
 *   2. host profiles.contact is revealed through get_event_by_slug under the EXACT
 *      same gate as host_wechat_id from R4: ONLY to a viewer who is unlocked
 *      (RSVP'd) AND while the event is locked AND inside the burn window
 *      (event_contact_open). A passerby / pre-lock / pre-成局 / anon viewer NEVER
 *      sees host_contact — double-blind, 阅后即焚. We mirror the R4 host_wechat_id
 *      reveal tests (lock + RSVP'd ⇒ appears; passerby / pre-lock ⇒ absent).
 *   3. get_public_events SILENT-HIDES a "未成局-past" event (past + capacity set +
 *      going<capacity + locked_at null) — no social death. It still INCLUDES an
 *      upcoming event, a 成局-past event (filled OR host-manually-locked), and an
 *      open局 (capacity null). i.e. ONLY the unfilled-unlocked-past row is hidden.
 *   4. No leak: profiles.contact and the full address (location_text/url) never
 *      appear for a passerby (JSON.stringify sentinel check).
 *
 * NB on 成局 vs is_locked: the silent-hide filter counts 成局 = 凑满 OR host MANUAL
 * lock (locked_at non-null) — the R4 time-derived auto-lock does NOT count here. We
 * therefore drive get_public_events scenarios with locked_at + capacity + RSVPs
 * directly, never relying on event_is_locked.
 *
 * Gated on a reachable local stack so the file skips (green) without Docker; where
 * the stack IS up, the gate must really hold.
 */
const LOCAL_UP = localStackRunning();

const FN_SLUG = "get_event_by_slug";
const FN_DISCOVER = "get_public_events";

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

/** The IN-parameter names of a function, in order (from pg_proc). */
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
type DiscoverRow = Record<string, unknown>;

/** Own-key check that doesn't trip on inherited props. */
function hasKey(obj: EventObj, key: string): boolean {
  return obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

// ── Sentinels — unique enough to prove a value never crosses a boundary. ───────────
const PREFIX = "s10a";
const HOST_CONTACT = "s10a-HOST-contact-SECRET@sentinel.invalid"; // profiles.contact (gated reveal)
const HOST_WX = "s10a-HOST-wechat-SECRET"; // profiles.wechat_id (the R4 sibling field)
const GUEST_WX = "s10a-GUEST-wechat-SECRET"; // an RSVP'd guest's wechat
const SENTINEL_ADDR = "s10a-FULL-ADDRESS-7-Secret-Lane-SENTINEL"; // location_text (2nd tier)
const SENTINEL_URL = "https://s10a-venue-secret.invalid/map"; // location_url (2nd tier)
const CITY = "s10a-Brooklyn"; // location_city (1st tier, MAY appear)

const CATEGORY = "s10a-category-dinner"; // events.category (1st-tier façade)
const CARD_VARIANT = "s10a-card-variant-aurora"; // events.card_variant (1st-tier façade)

// ── get_event_by_slug reveal scenarios ────────────────────────────────────────────
const E_UNLOCKED = "s10a-unlocked"; // not locked, far start — pre-lock probe
const E_LOCKED = "s10a-locked"; // manually locked, far start — reveal probe

// Fixed guest tokens so the unlocked-viewer probes are deterministic.
const T_UNLOCKED = "5a000000-0000-4000-8000-000000000010"; // RSVP'd going on E_UNLOCKED
const T_LOCKED = "5a000000-0000-4000-8000-000000000011"; // RSVP'd going on E_LOCKED

// ── get_public_events silent-hide scenarios ───────────────────────────────────────
const D_UPCOMING = "s10a-disc-upcoming"; // future + capacity set + unfilled ⇒ INCLUDED
const D_PAST_UNFILLED = "s10a-disc-past-unfilled"; // past + capacity + going<cap + unlocked ⇒ HIDDEN
const D_PAST_FILLED = "s10a-disc-past-filled"; // past + capacity + going>=cap ⇒ INCLUDED (成局=凑满)
const D_PAST_LOCKED = "s10a-disc-past-locked"; // past + capacity + going<cap + locked_at set ⇒ INCLUDED (成局=manual)
const D_PAST_OPEN = "s10a-disc-past-open"; // past + capacity NULL ⇒ INCLUDED (开放局 never hidden)

const TITLE_UPCOMING = "s10a Disc Upcoming";
const TITLE_PAST_UNFILLED = "s10a Disc Past Unfilled";
const TITLE_PAST_FILLED = "s10a Disc Past Filled";
const TITLE_PAST_LOCKED = "s10a Disc Past Locked";
const TITLE_PAST_OPEN = "s10a Disc Past Open";

describe("migration 0022 [SECURITY]: category/card_variant façade + gated host contact + 未成局 silent-hide", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

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

  /** get_event_by_slug over PostgREST; optionally with a guest token. */
  async function readSlug(
    client: SupabaseClient,
    slug: string,
    opts: { token?: string } = {},
  ): Promise<{ res: ApiResult; data: EventObj }> {
    const body: Record<string, unknown> = { slug };
    if (opts.token !== undefined) body.guest_token = opts.token;
    const res = (await client.rpc(FN_SLUG, body)) as ApiResult;
    return { res, data: (res.data as EventObj) ?? null };
  }

  /** Call get_public_events over the anon wire; return the parsed jsonb array. */
  async function readDiscover(
    client: SupabaseClient,
  ): Promise<{ res: ApiResult; rows: DiscoverRow[] }> {
    const res = (await client.rpc(FN_DISCOVER)) as ApiResult;
    const rows = (Array.isArray(res.data) ? res.data : []) as DiscoverRow[];
    return { res, rows };
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();
    expect(hostB?.id, "need >=2 host sessions (host B)").toBeTruthy();

    // The deployed interface is the contract. Pin the (unchanged) signatures so the
    // .rpc bodies line up — a rename/reorder on the recreate is itself a contract break.
    expect(inArgNames(FN_SLUG), "get_event_by_slug keeps its 5-arg signature on recreate").toEqual([
      "slug",
      "guest_token",
      "password",
      "password_verified",
      "viewer_id",
    ]);
    expect(inArgNames(FN_DISCOVER), "get_public_events stays no-arg on recreate").toEqual([]);

    // The three additive columns must exist after the migration.
    for (const [tbl, col] of [
      ["events", "category"],
      ["events", "card_variant"],
      ["profiles", "contact"],
    ] as const) {
      const exists = scalar(
        runSql(
          `select count(*)::text from information_schema.columns
             where table_schema='public' and table_name='${tbl}' and column_name='${col}';`,
        ),
      );
      expect(exists, `${tbl}.${col} must exist after migration 0022`).toBe("1");
    }

    // Idempotent reset.
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);

    // Host A profile carries BOTH sentinels (single source of truth = profile).
    runSql(
      `insert into public.profiles (id, display_name, wechat_id, contact) values
         ('${hostA.id}', 's10a host A', '${HOST_WX}', '${HOST_CONTACT}')
       on conflict (id) do update
         set wechat_id = excluded.wechat_id, contact = excluded.contact,
             display_name = excluded.display_name;`,
    );
    runSql(
      `insert into public.profiles (id, display_name) values ('${hostB.id}', 's10a host B')
         on conflict (id) do nothing;`,
    );

    // ── Reveal-scenario events (get_event_by_slug). Both carry category/card_variant
    //    and the address sentinels. E_LOCKED is manually locked (locked_at = now()).
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, rsvp_enabled, date_tbd,
          category, card_variant, location_text, location_url, location_city,
          starts_at, ends_at, locked_at) values
         ('${hostA.id}','${E_UNLOCKED}','s10a unlocked','public','published', true, false,
          '${CATEGORY}','${CARD_VARIANT}','${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',
          now() + interval '10 days', null, null),
         ('${hostA.id}','${E_LOCKED}','s10a locked','public','published', true, false,
          '${CATEGORY}','${CARD_VARIANT}','${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}',
          now() + interval '10 days', null, now());`,
    );

    // A deterministic RSVP'd-going guest on each reveal event (the token unlocks the
    // viewer; the guest's wechat is irrelevant here but seeded for realism).
    for (const [slug, tok] of [
      [E_UNLOCKED, T_UNLOCKED],
      [E_LOCKED, T_LOCKED],
    ] as const) {
      runSql(
        `insert into public.guests (event_id, guest_token, display_name, wechat_id)
           values ((select id from public.events where slug='${slug}'), '${tok}'::uuid, 's10a attendee', '${GUEST_WX}');
         insert into public.rsvps (event_id, guest_id, status)
           select g.event_id, g.id, 'going' from public.guests g where g.guest_token='${tok}'::uuid;`,
      );
    }

    // ── Discovery-scenario events (get_public_events). All public+published. The
    //    silent-hide predicate is past + capacity set + going<capacity + locked_at null.
    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, rsvp_enabled, date_tbd,
          capacity, location_city, starts_at, ends_at, locked_at) values
         ('${hostA.id}','${D_UPCOMING}','${TITLE_UPCOMING}','public','published', true, false,
            10, '${CITY}', now() + interval '5 days', null, null),
         ('${hostA.id}','${D_PAST_UNFILLED}','${TITLE_PAST_UNFILLED}','public','published', true, false,
            10, '${CITY}', now() - interval '3 days', now() - interval '2 days', null),
         ('${hostA.id}','${D_PAST_FILLED}','${TITLE_PAST_FILLED}','public','published', true, false,
            2,  '${CITY}', now() - interval '3 days', now() - interval '2 days', null),
         ('${hostA.id}','${D_PAST_LOCKED}','${TITLE_PAST_LOCKED}','public','published', true, false,
            10, '${CITY}', now() - interval '3 days', now() - interval '2 days', now() - interval '4 days'),
         ('${hostA.id}','${D_PAST_OPEN}','${TITLE_PAST_OPEN}','public','published', true, false,
            null, '${CITY}', now() - interval '3 days', now() - interval '2 days', null);`,
    );

    // RSVPs to control 凑满 vs 未满 (occupancy counts going INCLUDING plus-ones):
    //   • D_PAST_UNFILLED: capacity 10, ONE going (1 < 10) ⇒ 未成局-past ⇒ HIDDEN.
    //   • D_PAST_FILLED  : capacity 2, one going +1 plus-one = 2 (>= 2) ⇒ 成局 ⇒ INCLUDED.
    //   • D_PAST_LOCKED  : capacity 10, ONE going (1 < 10) BUT locked_at set ⇒ 成局 ⇒ INCLUDED.
    //   • D_PAST_OPEN    : capacity NULL ⇒ predicate cannot fire ⇒ INCLUDED.
    for (const [slug, plus] of [
      [D_PAST_UNFILLED, 0],
      [D_PAST_FILLED, 1],
      [D_PAST_LOCKED, 0],
    ] as const) {
      const tok = `5a000000-0000-4000-8000-0000000001${slug === D_PAST_UNFILLED ? "01" : slug === D_PAST_FILLED ? "02" : "03"}`;
      runSql(
        `insert into public.guests (event_id, guest_token, display_name)
           values ((select id from public.events where slug='${slug}'), '${tok}'::uuid, 's10a disc guest');
         insert into public.rsvps (event_id, guest_id, status, plus_ones)
           select g.event_id, g.id, 'going', ${plus} from public.guests g where g.guest_token='${tok}'::uuid;`,
      );
    }
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    // Leave host A's wechat/contact on the profile — other suites seed their own.
  });

  // ── (1) category + card_variant on the normal tiered façade, present pre-lock ─────
  it.skipIf(!LOCAL_UP)(
    "[1] get_event_by_slug ALWAYS returns category + card_variant on the façade (anon, pre-lock)",
    async () => {
      const an = await readSlug(anon(), E_UNLOCKED);
      expect(an.res.error, JSON.stringify(an.res.error)).toBeNull();
      expect(an.data, "the unlocked public event returns a façade").not.toBeNull();

      // Present as KEYS and carry the seeded values, even to an anon passerby pre-lock.
      expect(hasKey(an.data, "category"), "category key is always on the façade").toBe(true);
      expect(hasKey(an.data, "card_variant"), "card_variant key is always on the façade").toBe(true);
      expect(an.data?.category, "category value surfaces (public card art)").toBe(CATEGORY);
      expect(an.data?.card_variant, "card_variant value surfaces (public card art)").toBe(CARD_VARIANT);
      // Sanity: the event is not locked yet.
      expect(an.data?.is_locked, "E_UNLOCKED reports is_locked=false").toBe(false);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[1] category + card_variant are present on a LOCKED event's façade too (always-on, gate-independent)",
    async () => {
      const an = await readSlug(anon(), E_LOCKED);
      expect(an.data?.category, "category present even on a locked event").toBe(CATEGORY);
      expect(an.data?.card_variant, "card_variant present even on a locked event").toBe(CARD_VARIANT);
      expect(an.data?.is_locked, "E_LOCKED reports is_locked=true").toBe(true);
    },
  );

  // ── (2) host_contact gated EXACTLY like host_wechat_id ───────────────────────────
  it.skipIf(!LOCAL_UP)(
    "[2] pre-lock: host_contact (and host_wechat_id) are NEVER returned — not to anon, not to an RSVP'd/unlocked viewer",
    async () => {
      // anon passerby on an unlocked event ⇒ no host_contact, no sentinel.
      const an = await readSlug(anon(), E_UNLOCKED);
      expect(hasKey(an.data, "host_contact"), "pre-lock anon ⇒ NO host_contact key").toBe(false);
      expect(hasKey(an.data, "host_wechat_id"), "pre-lock anon ⇒ NO host_wechat_id key (the sibling gate)").toBe(false);
      expect(JSON.stringify(an.data), "no host contact sentinel pre-lock").not.toContain(HOST_CONTACT);

      // The RSVP'd (unlocked) viewer STILL gets nothing pre-lock — unlock is necessary
      // but not sufficient; the event must also be locked + in the burn window.
      const unlocked = await readSlug(service(), E_UNLOCKED, { token: T_UNLOCKED });
      expect(unlocked.data?.unlocked, "valid token unlocks the address tier").toBe(true);
      expect(hasKey(unlocked.data, "host_contact"), "RSVP'd-but-not-locked ⇒ STILL no host_contact (double-blind)").toBe(false);
      expect(hasKey(unlocked.data, "host_wechat_id"), "…and STILL no host_wechat_id").toBe(false);
      expect(JSON.stringify(unlocked.data), "no host contact even when unlocked, pre-lock").not.toContain(HOST_CONTACT);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[2] locked event: an RSVP'd/unlocked viewer gets host_contact (== host_wechat_id gate); a passerby does NOT",
    async () => {
      // RSVP'd viewer on a LOCKED, in-window event ⇒ BOTH host_contact and
      // host_wechat_id revealed (identical gate).
      const unlocked = await readSlug(service(), E_LOCKED, { token: T_LOCKED });
      expect(unlocked.data?.unlocked, "token unlocks").toBe(true);
      expect(unlocked.data?.is_locked, "manually-locked ⇒ is_locked=true").toBe(true);
      expect(unlocked.data?.host_contact, "locked + unlocked ⇒ host contact revealed").toBe(HOST_CONTACT);
      expect(unlocked.data?.host_wechat_id, "…revealed under the SAME gate as host_wechat_id").toBe(HOST_WX);

      // A passerby (no token, not unlocked) on the SAME locked event ⇒ still nothing.
      const passerby = await readSlug(anon(), E_LOCKED);
      expect(passerby.data?.is_locked, "passerby still sees is_locked=true").toBe(true);
      expect(passerby.data?.unlocked, "passerby is not unlocked").toBe(false);
      expect(hasKey(passerby.data, "host_contact"), "a non-RSVP'd passerby NEVER gets host_contact, even once locked").toBe(false);
      expect(hasKey(passerby.data, "host_wechat_id"), "…nor host_wechat_id").toBe(false);
      expect(JSON.stringify(passerby.data), "no host contact to a passerby").not.toContain(HOST_CONTACT);
    },
  );

  // ── (3) get_public_events silent-hide: ONLY unfilled-unlocked-past is hidden ──────
  it.skipIf(!LOCAL_UP)(
    "[3] get_public_events EXCLUDES a 未成局-past event but INCLUDES upcoming / filled-past / locked-past / open-past",
    async () => {
      const { res, rows } = await readDiscover(anon());
      expect(res.error, JSON.stringify(res.error)).toBeNull();
      const slugs = rows.map((r) => String(r.slug));

      // The ONLY hidden row: past + capacity set + going<capacity + locked_at null.
      expect(slugs, "a 未成局-past event is silently hidden (no social death)").not.toContain(D_PAST_UNFILLED);

      // Everything else surfaces.
      expect(slugs, "an upcoming event is included").toContain(D_UPCOMING);
      expect(slugs, "a 成局-past event (凑满) is included").toContain(D_PAST_FILLED);
      expect(slugs, "a 成局-past event (host manual lock) is included").toContain(D_PAST_LOCKED);
      expect(slugs, "an 开放局-past event (capacity NULL) is included — never hidden").toContain(D_PAST_OPEN);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[3] the hidden 未成局-past event is not an existence oracle by TITLE either; the four included ones carry their titles",
    async () => {
      const { rows } = await readDiscover(anon());
      const titles = rows.map((r) => String(r.title));
      expect(titles, "the hidden event leaks no title").not.toContain(TITLE_PAST_UNFILLED);
      expect(titles).toContain(TITLE_UPCOMING);
      expect(titles).toContain(TITLE_PAST_FILLED);
      expect(titles).toContain(TITLE_PAST_LOCKED);
      expect(titles).toContain(TITLE_PAST_OPEN);
    },
  );

  // ── (4) No leak: host contact / full address never appear for a passerby ──────────
  it.skipIf(!LOCAL_UP)(
    "[4] a passerby's slug payload carries NO host contact and NO full address (location_text/url) — JSON.stringify check",
    async () => {
      // On both the unlocked and the locked event, the anon passerby payload must be
      // free of the host-contact sentinel AND the address sentinels.
      for (const slug of [E_UNLOCKED, E_LOCKED]) {
        const r = await readSlug(anon(), slug);
        const json = JSON.stringify(r.data ?? {});
        expect(json, `${slug}: host contact never rides along for a passerby`).not.toContain(HOST_CONTACT);
        expect(json, `${slug}: host wechat never rides along for a passerby`).not.toContain(HOST_WX);
        expect(json, `${slug}: full address (location_text) never rides along for a passerby`).not.toContain(SENTINEL_ADDR);
        expect(json, `${slug}: venue url never rides along for a passerby`).not.toContain(SENTINEL_URL);
        expect(hasKey(r.data, "host_contact"), `${slug}: no host_contact key for a passerby`).toBe(false);
        expect(hasKey(r.data, "location_text"), `${slug}: no location_text key for a passerby`).toBe(false);
        expect(hasKey(r.data, "location_url"), `${slug}: no location_url key for a passerby`).toBe(false);
      }
    },
  );

  it.skipIf(!LOCAL_UP)(
    "[4] get_public_events never rides the host contact or full address on any discovery card",
    async () => {
      const { res, rows } = await readDiscover(anon());
      expect(JSON.stringify(res.data), "no host contact sentinel in the discovery list").not.toContain(HOST_CONTACT);
      expect(JSON.stringify(res.data), "no full-address sentinel in the discovery list").not.toContain(SENTINEL_ADDR);
      for (const r of rows) {
        expect(hasKey(r, "host_contact"), "no host_contact key on a discovery card").toBe(false);
        expect(hasKey(r, "contact"), "no contact key on a discovery card").toBe(false);
        expect(hasKey(r, "location_text"), "no address key on a discovery card").toBe(false);
      }
    },
  );
});
