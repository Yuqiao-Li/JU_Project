import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/**
 * Step-10A task 6 — INDEPENDENT pure unit test for `lib/events/clone.ts`
 * (一键复用 / "再开一局" · dashboard.md).
 *
 * `cloneEventDefaults` is the single tested place that turns a host's OWN source
 * event row into the `EventDefaults` that PREFILL a brand-new create form
 * (`/new?from=<id>`). The page does the RLS-scoped read; this helper does the
 * field-copying. Per its own contract it is PURE — no `server-only`, no DB, no
 * React, no `Date.now()` — so this whole suite runs at the value boundary with
 * NO database, mirroring task-step10a-card-helpers.test.ts.
 *
 * Why the two `vi.mock`s below: clone.ts imports its collaborators through the
 * `@/` path alias, which vitest (no alias config) cannot resolve at runtime.
 *  - `@/lib/events/theme` is re-exported from the REAL module, so we exercise the
 *    real `themeColorFromJson` (no behavior is stubbed away).
 *  - `@/app/dashboard/events/event-form` is a `"use client"` React component, and
 *    clone.ts only imports a TYPE from it (`import { type EventDefaults }`, erased
 *    at runtime). It is stubbed to an empty module so the client/React/next-intl
 *    graph never loads into the node test worker.
 */

vi.mock("@/lib/events/theme", async () => await import("../lib/events/theme"));
vi.mock("@/app/dashboard/events/event-form", () => ({}));

const { cloneEventDefaults } = await import("../lib/events/clone");
type CloneSource = Parameters<typeof cloneEventDefaults>[0];

/**
 * A fully-populated, realistic source row. Every individual test forks from this
 * so each assertion isolates exactly one field/rule. The instant is chosen so the
 * +7d bump lands cleanly within the same month (no DST/month-rollover ambiguity).
 */
const SOURCE: CloneSource = {
  title: "周五桌游局",
  description: "带点零食，七点开始",
  date_tbd: false,
  starts_at: "2026-03-06T11:00:00.000Z",
  ends_at: "2026-03-06T14:00:00.000Z",
  location_text: "Joy 的客厅",
  location_url: "https://maps.example.com/x",
  location_city: "上海",
  visibility: "private",
  capacity: 8,
  allow_plus_ones: true,
  max_plus_ones: 3,
  rsvp_enabled: true,
  cover_image_url: "https://cdn.example.com/cover.jpg",
  theme: { color: "iris" },
  effect: "confetti",
  chip_in_url: "https://aa.example.com/pay",
  chip_in_note: "AA 一人 30",
  category: "game",
  card_variant: "neon",
};

describe("step-10A clone.ts: cloneEventDefaults COPIES the reusable shape", () => {
  it("copies title / description / location (text+url+city) verbatim", () => {
    const d = cloneEventDefaults(SOURCE);
    expect(d.title).toBe("周五桌游局");
    expect(d.description).toBe("带点零食，七点开始");
    expect(d.locationText).toBe("Joy 的客厅");
    expect(d.locationUrl).toBe("https://maps.example.com/x");
    expect(d.locationCity).toBe("上海");
  });

  it("copies capacity, the +1 toggle/limit, and the rsvp toggle", () => {
    const d = cloneEventDefaults(SOURCE);
    expect(d.capacity).toBe(8);
    expect(d.allowPlusOnes).toBe(true);
    expect(d.maxPlusOnes).toBe(3);
    expect(d.rsvpEnabled).toBe(true);
  });

  it("carries visibility (private stays private; anything not 'private' is public)", () => {
    expect(cloneEventDefaults(SOURCE).visibility).toBe("private");
    expect(cloneEventDefaults({ ...SOURCE, visibility: "public" }).visibility).toBe("public");
    // Unknown/garbage visibility collapses to the safe public default, never private.
    expect(cloneEventDefaults({ ...SOURCE, visibility: "weird" }).visibility).toBe("public");
  });

  it("copies category and card_variant (the 局卡 design choice)", () => {
    const d = cloneEventDefaults(SOURCE);
    expect(d.category).toBe("game");
    expect(d.cardVariant).toBe("neon");
  });

  it("copies the chip-in url + note", () => {
    const d = cloneEventDefaults(SOURCE);
    expect(d.chipInUrl).toBe("https://aa.example.com/pay");
    expect(d.chipInNote).toBe("AA 一人 30");
  });

  it("copies the look — cover image, theme color (via the real reader), and effect", () => {
    const d = cloneEventDefaults(SOURCE);
    expect(d.coverImageUrl).toBe("https://cdn.example.com/cover.jpg");
    expect(d.themeColor).toBe("iris");
    expect(d.effect).toBe("confetti");
  });

  it("normalizes null content columns to the form's empty-string / default shape", () => {
    const d = cloneEventDefaults({
      ...SOURCE,
      description: null,
      location_text: null,
      location_url: null,
      location_city: null,
      cover_image_url: null,
      chip_in_url: null,
      chip_in_note: null,
      category: null,
      card_variant: null,
      effect: null,
      theme: null,
    });
    expect(d.description).toBe("");
    expect(d.locationText).toBe("");
    expect(d.locationUrl).toBe("");
    expect(d.locationCity).toBe("");
    expect(d.coverImageUrl).toBe("");
    expect(d.chipInUrl).toBe("");
    expect(d.chipInNote).toBe("");
    expect(d.category).toBe("");
    expect(d.cardVariant).toBe("");
    // null effect / theme fall back to the form defaults, not literal null.
    expect(d.effect).toBe("none");
    expect(d.themeColor).toBe("coral");
  });
});

describe("step-10A clone.ts: cloneEventDefaults BUMPS the time forward (时间顺延)", () => {
  it("moves starts_at and ends_at forward by exactly one week (same wall-clock, +7d)", () => {
    const d = cloneEventDefaults(SOURCE);
    expect(d.startsAt).toBe("2026-03-13T11:00:00.000Z");
    expect(d.endsAt).toBe("2026-03-13T14:00:00.000Z");
  });

  it("the bump is exactly 7×24h in UTC milliseconds", () => {
    const d = cloneEventDefaults(SOURCE);
    const delta = Date.parse(d.startsAt!) - Date.parse(SOURCE.starts_at!);
    expect(delta).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("a null end (no end time set) stays null after the bump", () => {
    const d = cloneEventDefaults({ ...SOURCE, ends_at: null });
    expect(d.startsAt).toBe("2026-03-13T11:00:00.000Z");
    expect(d.endsAt).toBeNull();
  });

  it("an unparseable stored instant collapses to null rather than carrying garbage", () => {
    const d = cloneEventDefaults({ ...SOURCE, starts_at: "not-a-date" });
    expect(d.startsAt).toBeNull();
  });
});

describe("step-10A clone.ts: a date_tbd source stays date_tbd (TBD → TBD)", () => {
  it("keeps the date_tbd flag and leaves null times null (re-decided via the poll)", () => {
    const d = cloneEventDefaults({
      ...SOURCE,
      date_tbd: true,
      starts_at: null,
      ends_at: null,
    });
    expect(d.dateTbd).toBe(true);
    expect(d.startsAt).toBeNull();
    expect(d.endsAt).toBeNull();
  });

  it("a dated (non-TBD) source clones to a dated event (flag preserved either way)", () => {
    expect(cloneEventDefaults(SOURCE).dateTbd).toBe(false);
  });
});

describe("step-10A clone.ts: cloneEventDefaults DROPS the source identity (never leaks)", () => {
  // A clone is a FRESH, unwritten event — not a copy of the original's identity or
  // its guest data. The result must be a clean CREATE shape regardless of source.
  it("mints a blank id, draft status, and no password — never the source's", () => {
    const d = cloneEventDefaults(SOURCE);
    expect(d.id).toBe("");
    expect(d.status).toBe("draft");
    expect(d.hasPassword).toBe(false);
  });

  it("never carries slug / host_id / id / status / password from the source object", () => {
    // Even if a caller hands a row that ALSO contains identity columns, none of them
    // can appear in the returned defaults (the helper reads only the safe subset).
    const poisoned = {
      ...SOURCE,
      id: "evt_secret_123",
      slug: "leaky-slug",
      status: "published",
      host_id: "host_other",
      password_hash: "$2a$secrethash",
    } as CloneSource;
    const d = cloneEventDefaults(poisoned);

    // The created shape's own fields are the fresh CREATE values, not the source's.
    expect(d.id).toBe("");
    expect(d.status).toBe("draft");
    expect(d.hasPassword).toBe(false);

    // No identity-bearing value leaks into ANY field of the returned defaults.
    const serialized = JSON.stringify(d);
    for (const secret of [
      "evt_secret_123",
      "leaky-slug",
      "published",
      "host_other",
      "$2a$secrethash",
    ]) {
      expect(serialized.includes(secret), `clone must not leak "${secret}"`).toBe(false);
    }
    // And there is simply no slug / host_id / password key on the create shape.
    expect("slug" in d).toBe(false);
    expect("hostId" in d).toBe(false);
    expect("password" in d).toBe(false);
  });

  it("leaves wechatId blank (the page fills it from the host profile, not the source)", () => {
    expect(cloneEventDefaults(SOURCE).wechatId).toBe("");
  });
});

/**
 * Focused source-grep — the wiring that makes the helper reachable from the UI.
 * Pins ONLY the contract this task owns (re-open a 局 from the dashboard), without
 * duplicating task-5's full dashboard assertions.
 */
const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

describe("step-10A wiring: /dashboard surfaces the 局卡 + 一键复用 (再开一局) link", () => {
  const PAGE = src("app/dashboard/page.tsx");

  it("renders the shared EventCard for the host hero (局卡顶)", () => {
    expect(PAGE, "imports the shared EventCard").toContain('from "@/components/events/event-card"');
    expect(/<EventCard\b/.test(PAGE), "renders an EventCard").toBe(true);
  });

  it("offers a 再开一局 / reuse link that targets the create form with ?from=<event id>", () => {
    // The clone affordance routes to the create page seeded by the source event id.
    expect(/\/dashboard\/events\/new\?from=\$\{[^}]*\.id\}/.test(PAGE), "links to /new?from=<id>").toBe(true);
    // The link copy comes through the shared reuse translation key, not a hardcoded string.
    expect(PAGE, "uses the hero.reuse i18n key for the link label").toMatch(/hero\.reuse/);
  });

  it("the new-event page consumes ?from and prefills via cloneEventDefaults", () => {
    const NEW = src("app/dashboard/events/new/page.tsx");
    expect(NEW, "imports the clone helper").toContain('from "@/lib/events/clone"');
    expect(NEW, "calls cloneEventDefaults on the source row").toContain("cloneEventDefaults(");
    expect(NEW, "reads the ?from search param").toMatch(/from\??\s*[:}]/);
  });
});
