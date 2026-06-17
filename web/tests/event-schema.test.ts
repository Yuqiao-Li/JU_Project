import { describe, expect, it } from "vitest";

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
