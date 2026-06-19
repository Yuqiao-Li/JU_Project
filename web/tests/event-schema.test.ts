import { describe, expect, it } from "vitest";

import { CATEGORY_KEYS, DEFAULT_CATEGORY } from "../lib/events/category";
import { parseEventForm } from "../lib/events/schema";
import { DEFAULT_THEME, EFFECT_KEYS, THEME_KEYS } from "../lib/events/theme";

/**
 * Task 2.2b — create/edit form parsing for cover + theme + chip_in (unit).
 *
 * `parseEventForm` is the zod boundary every host write crosses (CLAUDE.md), so it
 * is where the new fields are normalised and pinned to safe values. These are pure
 * assertions over FormData → parsed input:
 *
 *   * theme color is constrained to a known palette (an unknown value fails closed
 *     to the default, never reaches the DB as junk) and stored as `{color}` jsonb;
 *   * effect is constrained to a small preset set ("不堆砌"), with "none" → null;
 *   * chip_in is display-only metadata: an optional URL (rejected if malformed) and
 *     a short optional note;
 *   * cover_image_url passes through (set by the uploader) but is still validated.
 */

/** Build a FormData from a plain record (mirrors a posted <form>). */
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  // A title + visibility are always required for a valid parse.
  fd.set("title", fields.title ?? "Test Event");
  fd.set("visibility", fields.visibility ?? "public");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function parseOk(fields: Record<string, string>) {
  const r = parseEventForm(form(fields));
  if (!r.ok) throw new Error(`expected parse to succeed: ${r.message}`);
  return r.value;
}

describe("task 2.2b: theme color parsing", () => {
  it("keeps a known palette color and stores it as { color } jsonb", () => {
    const known = THEME_KEYS.find((k) => k !== DEFAULT_THEME) ?? DEFAULT_THEME;
    const { input } = parseOk({ theme_color: known });
    expect(input.theme).toEqual({ color: known });
  });

  it("falls back to the default for an unknown/forged color (never junk to the DB)", () => {
    expect(parseOk({ theme_color: "neon-chartreuse" }).input.theme).toEqual({ color: DEFAULT_THEME });
    expect(parseOk({}).input.theme).toEqual({ color: DEFAULT_THEME });
  });
});

describe("task 2.2b: effect parsing", () => {
  it("keeps a known preset effect", () => {
    const real = EFFECT_KEYS.find((e) => e !== "none");
    expect(real, "there should be at least one non-none effect").toBeTruthy();
    expect(parseOk({ effect: real as string }).input.effect).toBe(real);
  });

  it("normalises 'none' and unknown effects to null", () => {
    expect(parseOk({ effect: "none" }).input.effect).toBeNull();
    expect(parseOk({ effect: "screen-melt" }).input.effect).toBeNull();
    expect(parseOk({}).input.effect).toBeNull();
  });
});

describe("task 2.2b: chip_in parsing (display-only metadata)", () => {
  it("keeps a valid chip-in link and note", () => {
    const { input } = parseOk({
      chip_in_url: "https://venmo.com/u/host",
      chip_in_note: "$10 covers drinks",
    });
    expect(input.chip_in_url).toBe("https://venmo.com/u/host");
    expect(input.chip_in_note).toBe("$10 covers drinks");
  });

  it("treats empty chip-in fields as null", () => {
    const { input } = parseOk({ chip_in_url: "", chip_in_note: "   " });
    expect(input.chip_in_url).toBeNull();
    expect(input.chip_in_note).toBeNull();
  });

  it("rejects a malformed chip-in link", () => {
    const r = parseEventForm(form({ chip_in_url: "not a url" }));
    expect(r.ok).toBe(false);
  });

  it("rejects an over-long chip-in note", () => {
    const r = parseEventForm(form({ chip_in_note: "x".repeat(5000) }));
    expect(r.ok).toBe(false);
  });
});

describe("task 2.2b: cover_image_url parsing", () => {
  it("passes a valid cover URL through and nulls an empty one", () => {
    expect(parseOk({ cover_image_url: "https://cdn.example.com/a/b.png" }).input.cover_image_url).toBe(
      "https://cdn.example.com/a/b.png",
    );
    expect(parseOk({ cover_image_url: "" }).input.cover_image_url).toBeNull();
  });

  it("rejects a malformed cover URL", () => {
    expect(parseEventForm(form({ cover_image_url: "javascript:alert(1)" })).ok).toBe(false);
  });
});

/**
 * Step-10A Task 3 — 建局 publish gate (docs/prd/event-create.md 发布必填).
 *
 * Publishing now requires BOTH a "when" (a real start time OR an explicit "date TBD")
 * AND a city. Saving as a DRAFT carries NO such requirement — an incomplete event can
 * always be parked as a draft. These are pure FormData → ParseResult assertions over the
 * publish gate; the `form()` helper above does NOT set `intent`, so the baseline is a
 * draft, and we opt into publishing by setting intent="publish".
 *
 * A valid UTC instant + zone is required by the timezone contract (parseDateTime rejects
 * a zoneless wall-clock), so we use a canonical Z-suffixed ISO for the start time.
 */
const VALID_START = "2026-07-01T18:00:00.000Z";

describe("Step-10A: publish gate (when + city required; drafts exempt)", () => {
  it("rejects publish with NO start time AND NO date_tbd (needs a when)", () => {
    const r = parseEventForm(form({ intent: "publish", location_city: "Brooklyn" }));
    expect(r.ok, "publish without a when must be rejected").toBe(false);
  });

  it("rejects publish with a time but NO city (needs a city)", () => {
    const r = parseEventForm(form({ intent: "publish", starts_at: VALID_START }));
    expect(r.ok, "publish without a city must be rejected").toBe(false);
  });

  it("rejects publish with date_tbd but NO city (needs a city even when the date is TBD)", () => {
    const r = parseEventForm(form({ intent: "publish", date_tbd: "on" }));
    expect(r.ok, "date_tbd does not exempt the city requirement").toBe(false);
  });

  it("accepts publish with date_tbd + a city (no concrete time required when TBD)", () => {
    const r = parseEventForm(form({ intent: "publish", date_tbd: "on", location_city: "Queens" }));
    if (!r.ok) throw new Error(`expected publish to succeed: ${r.message}`);
    expect(r.value.intent).toBe("publish");
    expect(r.value.input.date_tbd).toBe(true);
    expect(r.value.input.starts_at).toBeNull();
    expect(r.value.input.location_city).toBe("Queens");
  });

  it("accepts publish with a real start time + a city", () => {
    const r = parseEventForm(form({ intent: "publish", starts_at: VALID_START, location_city: "Manhattan" }));
    if (!r.ok) throw new Error(`expected publish to succeed: ${r.message}`);
    expect(r.value.intent).toBe("publish");
    expect(r.value.input.starts_at).toBe(VALID_START);
    expect(r.value.input.location_city).toBe("Manhattan");
  });

  it("a DRAFT saves with NO time and NO city (the gate is publish-only)", () => {
    const r = parseEventForm(form({ intent: "draft" }));
    if (!r.ok) throw new Error(`expected draft to succeed: ${r.message}`);
    expect(r.value.intent).toBe("draft");
    expect(r.value.input.starts_at).toBeNull();
    expect(r.value.input.location_city).toBeNull();
  });

  it("an absent intent defaults to draft and is exempt from the publish gate", () => {
    // form() never sets intent → draft baseline, which must save with no when/city.
    const r = parseEventForm(form({}));
    if (!r.ok) throw new Error(`expected draft to succeed: ${r.message}`);
    expect(r.value.intent).toBe("draft");
  });

  it("uses the caller-supplied localized publish-gate messages when given", () => {
    const needWhen = "本地化:需要时间";
    const needCity = "本地化:需要城市";
    const noWhen = parseEventForm(form({ intent: "publish", location_city: "Bronx" }), { needWhen, needCity });
    expect(noWhen.ok).toBe(false);
    if (!noWhen.ok) expect(noWhen.message).toBe(needWhen);

    const noCity = parseEventForm(form({ intent: "publish", starts_at: VALID_START }), { needWhen, needCity });
    expect(noCity.ok).toBe(false);
    if (!noCity.ok) expect(noCity.message).toBe(needCity);
  });
});

/**
 * Step-10A Task 3 — 建局 category + chosen 局卡 design variant.
 *
 * Category is constrained to a known set (a forged/absent value fails closed to the
 * generic default — never junk to events.category); card_variant is a free-form,
 * length-capped, optional key for the auto-generated card the host picked.
 */
describe("Step-10A: category parsing", () => {
  it("defaults to the generic category when absent", () => {
    expect(parseOk({}).input.category).toBe(DEFAULT_CATEGORY);
  });

  it("keeps a known category when present", () => {
    const known = CATEGORY_KEYS.find((k) => k !== DEFAULT_CATEGORY);
    expect(known, "there should be at least one non-generic category").toBeTruthy();
    expect(parseOk({ category: known as string }).input.category).toBe(known);
  });

  it("fails closed to the generic default for an unknown/forged category (never junk to the DB)", () => {
    expect(parseOk({ category: "blockchain-rave" }).input.category).toBe(DEFAULT_CATEGORY);
  });
});

describe("Step-10A: card_variant parsing", () => {
  it("keeps a non-empty card_variant key", () => {
    expect(parseOk({ card_variant: "meal-warm-01" }).input.card_variant).toBe("meal-warm-01");
  });

  it("nulls an empty/whitespace card_variant", () => {
    expect(parseOk({ card_variant: "" }).input.card_variant).toBeNull();
    expect(parseOk({ card_variant: "   " }).input.card_variant).toBeNull();
  });

  it("caps an over-long card_variant at 80 chars (the DB never sees junk)", () => {
    const variant = parseOk({ card_variant: "v".repeat(200) }).input.card_variant;
    expect(variant).not.toBeNull();
    expect((variant as string).length).toBe(80);
  });
});
