import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildEventOgMetadata } from "../lib/events/og";
import type { EventView } from "../lib/events/view";
import { anonClient, infra, serviceClient } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 6.2 [SECURITY] — OG meta / share preview (TEST-SPEC §6.2). Written by the
 * INDEPENDENT test agent (never wrote the implementation) with the stance "assume
 * the share card over-shares".
 *
 * THE GUARANTEE (task 禁止: "OG 不得泄露完整地址/名单"; 验收: "预览显示标题+封面";
 * TEST-SPEC §6.2: "私密/密码活动的 OG 输出 → 断言含 title/cover/description,不含
 * location_text"). The unfurl card for `/{slug}` may carry ONLY the first tier —
 * title, cover, description — never the full address (`location_text`/`location_url`,
 * second tier) nor the guest list / contact / tokens / hash (third tier).
 *
 * TWO TIERS OF ASSERTION:
 *
 *  1) UNIT — `buildEventOgMetadata` is a PURE function over the event façade (no
 *     `server-only`, no DB; mirrors `calendar.ts`). These tests pin its mapping AND
 *     prove it is leak-proof BY CONSTRUCTION: even when handed a façade that itself
 *     carries the address (a hypothetical regression) or stray third-tier keys, the
 *     card never surfaces them, because the builder reads only title/desc/cover.
 *
 *  2) RPC BOUNDARY — the page's `generateMetadata` resolves the façade through the
 *     trusted role with NO guest token and NO password credential (an unfurl bot
 *     carries neither). We reproduce exactly that read (`get_event_by_slug` with no
 *     token/password) for a PRIVATE, a PASSWORD and a PUBLIC event and assert the
 *     payload it feeds the builder is ALREADY first-tier-only — so the address can't
 *     reach the card from either side. This is stricter than grepping rendered HTML:
 *     a field absent from this payload can't be on the card, and the seed address is
 *     a unique sentinel so a leak is unambiguous. Gated on a reachable local stack so
 *     the file skips green without Docker; where the stack is up the gate must hold.
 */

type Meta = ReturnType<typeof buildEventOgMetadata>;

// ── Sentinels for the UNIT tier (distinct, unambiguous strings) ───────────────
const TITLE = "OG62 Rooftop Party";
const DESC = "Sunset drinks and a tiny DJ set. Bring a friend.";
const COVER = "https://cdn.example.com/og62/cover.png";
const CITY = "og62-Citytown"; // location_city — FIRST tier (city-level), allowed to appear

const SENTINEL_ADDR = "OG62-FULL-ADDRESS-77-Secret-Lane-DO-NOT-LEAK"; // location_text (2nd tier)
const SENTINEL_URL = "https://og62-venue-map.invalid/secret-pin"; // location_url (2nd tier)
const SENTINEL_CONTACT = "og62-host-only-contact@sentinel.invalid"; // contact (3rd tier)
const SENTINEL_GUEST = "og62-Guestlist-Person-DO-NOT-LEAK"; // a guest-list name (3rd tier)
const SENTINEL_TOKEN = "og62-guest-token-3f9a-DO-NOT-LEAK"; // a guest_token (3rd tier)
const SENTINEL_HASH = "$2b$12$og62RawPasswordHashDoNotLeak"; // view_password_hash (3rd tier)

/** The only keys a share card may ever expose — anything else is a pass-through leak. */
const ALLOWED_KEYS = new Set(["title", "description", "openGraph", "twitter", "robots"]);

/** A clean first-tier published façade (required keys + overrides). */
function ev(overrides: Partial<EventView> = {}): EventView {
  return {
    slug: "og62-rooftop-party-x7k2m9qpvw",
    title: TITLE,
    description: DESC,
    cover_image_url: COVER,
    visibility: "public",
    status: "published",
    location_city: CITY,
    ...overrides,
  };
}

/**
 * A façade that ALSO carries every tier it must never surface: the full address +
 * map URL (2nd tier) and out-of-type 3rd-tier keys (contact, a guest token, the raw
 * hash, a guest-list name). The builder reads ONLY title/description/cover, so none
 * may appear on the card; the cast lets us attach keys EventView rightly omits.
 */
function leaky(overrides: Record<string, unknown> = {}): EventView {
  return {
    ...ev(),
    location_text: SENTINEL_ADDR,
    location_url: SENTINEL_URL,
    contact: SENTINEL_CONTACT,
    guest_token: SENTINEL_TOKEN,
    view_password_hash: SENTINEL_HASH,
    guests: [{ display_name: SENTINEL_GUEST }],
    ...overrides,
  } as unknown as EventView;
}

function og(m: Meta): Record<string, unknown> {
  return (m.openGraph ?? {}) as Record<string, unknown>;
}
function tw(m: Meta): Record<string, unknown> {
  return (m.twitter ?? {}) as Record<string, unknown>;
}

/** No 2nd/3rd-tier sentinel may appear ANYWHERE in the serialized card. */
function assertNoSensitive(m: Meta, label: string): void {
  const json = JSON.stringify(m);
  expect(json, `${label}: full address (location_text) must never reach the OG card`).not.toContain(
    SENTINEL_ADDR,
  );
  expect(json, `${label}: map URL (location_url) must never reach the OG card`).not.toContain(
    SENTINEL_URL,
  );
  expect(json, `${label}: host-only contact must never reach the OG card`).not.toContain(
    SENTINEL_CONTACT,
  );
  expect(json, `${label}: a guest-list name must never reach the OG card`).not.toContain(
    SENTINEL_GUEST,
  );
  expect(json, `${label}: a guest_token must never reach the OG card`).not.toContain(SENTINEL_TOKEN);
  expect(json, `${label}: the raw password hash must never reach the OG card`).not.toContain(
    SENTINEL_HASH,
  );
}

/** Only OG-shaped keys may exist — proves no arbitrary façade field passes through. */
function assertOnlyOgKeys(m: Meta, label: string): void {
  for (const k of Object.keys(m)) {
    expect(ALLOWED_KEYS.has(k), `${label}: unexpected metadata key leaked through: ${k}`).toBe(true);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UNIT — buildEventOgMetadata (the share-card builder, pure)
// ══════════════════════════════════════════════════════════════════════════════
describe("task 6.2 [SECURITY]: buildEventOgMetadata — first-tier-only share card (TEST-SPEC §6.2)", () => {
  it("maps a published event to a title + description + cover card (含 title/cover/description)", () => {
    const m = buildEventOgMetadata(ev());
    expect(m.title).toBe(TITLE);
    expect(m.description).toBe(DESC);
    expect(og(m).title).toBe(TITLE);
    expect(og(m).description).toBe(DESC);
    expect(tw(m).title).toBe(TITLE);
    expect(tw(m).description).toBe(DESC);
    expect(JSON.stringify(m), "the cover IS the og:image (预览显示封面)").toContain(COVER);
    expect(tw(m).card, "a cover ⇒ large summary card").toBe("summary_large_image");
    expect(m.robots, "a published event is indexable (not the 404 fallback)").toBeUndefined();
    assertOnlyOgKeys(m, "published");
  });

  it("never surfaces the full address even when the façade itself carries it (不含 location_text)", () => {
    // THE core §6.2 assertion, hardened: even if a regression let the address ride in
    // the façade, the builder must not put it on the card (it never reads location_text).
    const m = buildEventOgMetadata(leaky());
    assertNoSensitive(m, "leaky façade");
    expect(m.title, "still a real preview").toBe(TITLE);
    expect(JSON.stringify(m), "cover still present").toContain(COVER);
    assertOnlyOgKeys(m, "leaky façade");
  });

  it("a PRIVATE event's card carries title/cover/description but never the address (私密)", () => {
    const m = buildEventOgMetadata(leaky({ visibility: "private" }));
    expect(m.title).toBe(TITLE);
    expect(m.description).toBe(DESC);
    expect(JSON.stringify(m)).toContain(COVER);
    assertNoSensitive(m, "private façade");
    assertOnlyOgKeys(m, "private façade");
  });

  it("a PASSWORD-locked façade still previews title/cover/description, never the address (密码)", () => {
    // The shape get_event_by_slug returns for a locked event: no `status`, no location_*.
    const locked = {
      slug: "og62-locked-gala-x",
      title: TITLE,
      description: DESC,
      cover_image_url: COVER,
      visibility: "public",
      requires_password: true,
      locked: true,
      unlocked: false,
    } as unknown as EventView;

    const m = buildEventOgMetadata(locked);
    expect(m.title, "a published password event DOES unfurl (验收: 预览显示标题+封面)").toBe(TITLE);
    expect(m.robots, "locked ≠ 'not found' — still indexable").toBeUndefined();
    expect(m.description).toBe(DESC);
    expect(JSON.stringify(m)).toContain(COVER);

    // Adversarial: even a locked façade that leaked the address must drop it.
    const m2 = buildEventOgMetadata({
      slug: "og62-locked-gala-x",
      title: TITLE,
      description: DESC,
      cover_image_url: COVER,
      visibility: "public",
      requires_password: true,
      locked: true,
      unlocked: false,
      location_text: SENTINEL_ADDR,
      location_url: SENTINEL_URL,
    } as unknown as EventView);
    assertNoSensitive(m2, "locked façade carrying a leaked address");
    expect(m2.title).toBe(TITLE);
  });

  it("a missing event (null) → non-indexing 'Event not found', naming/mapping nothing", () => {
    const m = buildEventOgMetadata(null);
    expect(m.title).toBe("Event not found");
    expect(m.robots, "a missing event must not be indexed").toEqual({ index: false, follow: false });
    const json = JSON.stringify(m);
    expect(json).not.toContain(TITLE);
    expect(json).not.toContain(DESC);
    expect(json).not.toContain(COVER);
    assertOnlyOgKeys(m, "null event");
  });

  it("a DRAFT event → 'Event not found' fallback; never names, maps, or leaks the unpublished event", () => {
    const m = buildEventOgMetadata(leaky({ status: "draft" }));
    expect(m.title, "an unpublished event must not be named in a preview").toBe("Event not found");
    expect(m.robots).toEqual({ index: false, follow: false });
    const json = JSON.stringify(m);
    expect(json, "draft title not named").not.toContain(TITLE);
    expect(json, "draft cover not mapped").not.toContain(COVER);
    assertNoSensitive(m, "draft façade"); // and the address still never leaks
    assertOnlyOgKeys(m, "draft event");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// UNIT — cover image: only absolute http(s) becomes og:image (no injection / leak)
// ══════════════════════════════════════════════════════════════════════════════
describe("task 6.2: OG cover image accepts only absolute http(s) URLs", () => {
  it("uses an absolute https cover as og:image (large summary card)", () => {
    const m = buildEventOgMetadata(ev({ cover_image_url: "https://cdn.example.com/og62/x.png" }));
    expect(JSON.stringify(m)).toContain("https://cdn.example.com/og62/x.png");
    expect(tw(m).card).toBe("summary_large_image");
  });

  it("accepts http as well as https", () => {
    const m = buildEventOgMetadata(ev({ cover_image_url: "http://cdn.example.com/og62/x.png" }));
    expect(JSON.stringify(m)).toContain("http://cdn.example.com/og62/x.png");
  });

  it("omits a RELATIVE cover (downgrades to a plain summary card, no image)", () => {
    const m = buildEventOgMetadata(ev({ cover_image_url: "/local/secret-cover.png" }));
    const json = JSON.stringify(m);
    expect(json).not.toContain("/local/secret-cover.png");
    expect(json, "no images key when the cover is unusable").not.toContain("images");
    expect(tw(m).card).toBe("summary");
  });

  it("omits a non-http(s) scheme cover (javascript:/data:/protocol-relative/ftp:)", () => {
    for (const bad of [
      "javascript:alert(1)//og62",
      "data:text/html;base64,AAAAog62",
      "//evil.example/og62.png",
      "ftp://og62/x.png",
    ]) {
      const m = buildEventOgMetadata(ev({ cover_image_url: bad }));
      const json = JSON.stringify(m);
      expect(json, `${bad} must not become an image`).not.toContain(bad);
      expect(json, `${bad}: no images key`).not.toContain("images");
      expect(tw(m).card).toBe("summary");
    }
  });

  it("omits a whitespace-only or null cover", () => {
    expect(JSON.stringify(buildEventOgMetadata(ev({ cover_image_url: "   " })))).not.toContain(
      "images",
    );
    expect(JSON.stringify(buildEventOgMetadata(ev({ cover_image_url: null })))).not.toContain(
      "images",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// UNIT — description: first-tier host text, card-sized, safe default
// ══════════════════════════════════════════════════════════════════════════════
describe("task 6.2: OG description (first-tier host text)", () => {
  it("falls back to a neutral invite line when the description is blank/null/whitespace", () => {
    const blanks: (string | null)[] = ["", null, "   \n  "];
    for (const blank of blanks) {
      const m = buildEventOgMetadata(ev({ description: blank }));
      expect(m.description, "a non-empty neutral default").toBeTruthy();
      expect(m.description).not.toBe("");
      assertNoSensitive(m, `blank description (${JSON.stringify(blank)})`);
    }
  });

  it("collapses internal whitespace to single spaces", () => {
    const m = buildEventOgMetadata(ev({ description: "line one\n\n  line   two" }));
    expect(m.description).toBe("line one line two");
  });

  it("truncates an over-long description to a card-sized, ellipsised summary", () => {
    const m = buildEventOgMetadata(ev({ description: "z".repeat(500) }));
    const d = String(m.description);
    expect(d.length, "card-sized").toBeLessThanOrEqual(200);
    expect(d.endsWith("…"), "ellipsised").toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// RPC BOUNDARY — generateMetadata's real input is already first-tier-only
// ══════════════════════════════════════════════════════════════════════════════
const LOCAL_UP = localStackRunning();

const PREFIX = "t62";
const SLUG_PUB = "t62-public-party"; // public, published
const SLUG_PRIV = "t62-private-soiree"; // private, published (SSR/OG-only)
const SLUG_PWD = "t62-locked-gala"; // public + password (locked façade)
const SLUG_MISSING = "t62-no-such-event-x"; // unknown ⇒ null

const T62_ADDR = "t62-FULL-ADDRESS-13-Hidden-Way-SENTINEL"; // location_text (2nd tier)
const T62_URL = "https://t62-map.invalid/secret-pin"; // location_url (2nd tier)
const T62_CITY = "t62-Metropolis"; // location_city (1st tier)
const T62_PASSWORD = "t62-correct-horse-battery";
const COVER_PUB = "https://cdn.invalid/t62/pub-cover.png";
const COVER_PRIV = "https://cdn.invalid/t62/priv-cover.png";
const COVER_PWD = "https://cdn.invalid/t62/pwd-cover.png";

type ApiResult = { data: unknown; error: unknown };
type EventObj = Record<string, unknown> | null;

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

/** Own-key check (not tripped by inherited props) — for "key OMITTED" assertions. */
function hasKey(obj: EventObj, key: string): boolean {
  return obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

describe("task 6.2 [SECURITY]: generateMetadata's data path yields a first-tier-only façade (RPC boundary)", () => {
  const i = infra();
  const hostA = i.hosts[0];

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);

    runSql(
      `insert into public.profiles (id, display_name) values ('${hostA.id}','t62 host')
         on conflict (id) do nothing;`,
    );

    // All three carry the SAME sentinel address/url/city so a leak is unambiguous.
    runSql(
      `insert into public.events
         (host_id, slug, title, description, cover_image_url, visibility, status,
          capacity, location_text, location_url, location_city, hide_guest_count) values
         ('${hostA.id}','${SLUG_PUB}','t62 Public Party','t62 public desc','${COVER_PUB}','public','published',10,'${T62_ADDR}','${T62_URL}','${T62_CITY}',false),
         ('${hostA.id}','${SLUG_PRIV}','t62 Private Soiree','t62 private desc','${COVER_PRIV}','private','published',10,'${T62_ADDR}','${T62_URL}','${T62_CITY}',false),
         ('${hostA.id}','${SLUG_PWD}','t62 Locked Gala','t62 password desc','${COVER_PWD}','public','published',10,'${T62_ADDR}','${T62_URL}','${T62_CITY}',false);`,
    );

    // Real bcrypt hash on the password event (the page resolves OG with NO password,
    // so this must come back as the locked façade — title/cover/desc only).
    runSql(
      `update public.events
         set view_password_hash = extensions.crypt('${T62_PASSWORD}', extensions.gen_salt('bf', 12))
         where slug = '${SLUG_PWD}';`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  /** Reproduce generateMetadata's read: readEventBySlug(slug) → trusted role, NO token/password. */
  async function ogRead(slug: string): Promise<EventObj> {
    const res = (await serviceClient().rpc("get_event_by_slug", { slug })) as ApiResult;
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    return (res.data as EventObj) ?? null;
  }

  it.skipIf(!LOCAL_UP)(
    "PRIVATE event: the OG read (trusted role, no token) omits location_text; the built card carries no address",
    async () => {
      const data = await ogRead(SLUG_PRIV);
      expect(data, "trusted role passes the private gate (D3)").not.toBeNull();
      expect(data?.unlocked, "no token ⇒ not unlocked").toBe(false);
      expect(hasKey(data, "location_text"), "未解锁 ⇒ location_text 省略").toBe(false);
      expect(hasKey(data, "location_url"), "未解锁 ⇒ location_url 省略").toBe(false);
      expect(JSON.stringify(data), "address sentinel absent from the OG input").not.toContain(
        T62_ADDR,
      );

      const m = buildEventOgMetadata(data as unknown as EventView);
      expect(m.title).toBe("t62 Private Soiree");
      expect(JSON.stringify(m), "cover IS first tier (预览显示封面)").toContain(COVER_PRIV);
      expect(JSON.stringify(m), "address never on the card").not.toContain(T62_ADDR);
      expect(JSON.stringify(m)).not.toContain(T62_URL);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "PASSWORD event: the OG read returns the locked façade; the card previews title/cover/description, never the address",
    async () => {
      const data = await ogRead(SLUG_PWD);
      expect(data?.locked, "password event ⇒ locked façade").toBe(true);
      expect(data?.requires_password).toBe(true);
      expect(hasKey(data, "location_text"), "locked ⇒ no address key").toBe(false);
      expect(JSON.stringify(data)).not.toContain(T62_ADDR);

      const m = buildEventOgMetadata(data as unknown as EventView);
      expect(m.title, "published password event still unfurls").toBe("t62 Locked Gala");
      expect(m.robots, "a locked-but-published event is indexable").toBeUndefined();
      expect(JSON.stringify(m)).toContain(COVER_PWD);
      expect(JSON.stringify(m), "address never on the card").not.toContain(T62_ADDR);
      expect(JSON.stringify(m)).not.toContain(T62_URL);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "PUBLIC event: the OG read (no token) is first-tier; the address never reaches the card",
    async () => {
      const data = await ogRead(SLUG_PUB);
      expect(data?.unlocked).toBe(false);
      expect(hasKey(data, "location_text")).toBe(false);
      expect(JSON.stringify(data)).not.toContain(T62_ADDR);

      const m = buildEventOgMetadata(data as unknown as EventView);
      expect(m.title).toBe("t62 Public Party");
      expect(JSON.stringify(m)).toContain(COVER_PUB);
      expect(JSON.stringify(m)).not.toContain(T62_ADDR);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "unknown slug ⇒ null ⇒ the builder emits the non-indexing fallback (no event named)",
    async () => {
      const data = await ogRead(SLUG_MISSING);
      expect(data, "unknown slug returns null").toBeNull();
      const m = buildEventOgMetadata(null);
      expect(m.title).toBe("Event not found");
      expect(m.robots).toEqual({ index: false, follow: false });
    },
  );

  it.skipIf(!LOCAL_UP)(
    "defense in depth: a direct anon bypass of the PRIVATE slug RPC yields null — nothing for any OG path to surface",
    async () => {
      const res = (await anonClient().rpc("get_event_by_slug", { slug: SLUG_PRIV })) as ApiResult;
      expect((res.data as EventObj) ?? null, "anon never reads a private event (D3)").toBeNull();
    },
  );
});
