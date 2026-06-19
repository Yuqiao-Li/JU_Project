import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION GUARD — wrapper-based fields must not paint a DOUBLED focus ring (#4).
 *
 * THE BUG:
 *   The username field (`profile-form.tsx`) and the date-time field
 *   (`date-time-field.tsx`) put an `<input>` INSIDE a container that already shows focus
 *   via `focus-within:border-iris`. The inner input ALSO matched the app-wide
 *   `:focus-visible { outline: 2px solid iris; … }` rule in `globals.css`, so focusing
 *   the field painted a SECOND, offset ring INSIDE the bordered container.
 *
 * WHY THE FIRST FIX (a Tailwind `focus-visible:outline-none` utility) DID NOTHING:
 *   that global `:focus-visible` rule is UNLAYERED, and Tailwind utilities live in a
 *   cascade LAYER. An unlayered rule beats a layered one regardless of specificity — so
 *   the utility was silently overridden. The working fix is an UNLAYERED override rule in
 *   globals.css (`.focus-ring-off:focus-visible { outline: none }`) plus the
 *   `focus-ring-off` class on each wrapped input.
 *
 * INVARIANT (pinned so neither the class nor the unlayered override regresses):
 *   1. the username `<input id="username">` className contains `focus-ring-off`.
 *   2. the date-time field's masked `<input>` className contains `focus-ring-off`.
 *   3. globals.css carries the UNLAYERED `.focus-ring-off:focus-visible { outline: none }`
 *      override (the thing that actually wins over the app-wide ring).
 *   4. both wrappers keep `focus-within:border-iris` (the single focus indicator).
 *
 * Pure SOURCE-GREP (Node `fs`, NO DB, NO React render), comment-stripped first so prose
 * naming these tokens can't self-trip the grep. NB: a source grep can't prove the CSS
 * *renders* correctly (the cascade-layer trap is exactly why) — the real check is a
 * browser; this only locks in the mechanism so it isn't reverted.
 */

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Slice the `<input …>` element that carries the given attribute. */
function inputWith(code: string, attr: string): string {
  const idIdx = code.indexOf(attr);
  expect(idIdx, `source contains an input with ${attr}`).toBeGreaterThan(-1);
  const openIdx = code.lastIndexOf("<input", idIdx);
  const closeIdx = code.indexOf("/>", idIdx);
  expect(openIdx, "found the opening <input").toBeGreaterThan(-1);
  expect(closeIdx, "found the self-closing />").toBeGreaterThan(idIdx);
  return code.slice(openIdx, closeIdx);
}

const PROFILE = stripComments(src("app/dashboard/settings/profile-form.tsx"));
const PICKER = stripComments(src("components/events/date-time-field.tsx"));
const GLOBALS = src("app/globals.css"); // CSS — no JS comments to strip

describe("FOCUS-RING GUARD: wrapped fields show ONE focus indicator, not a doubled ring (#4)", () => {
  it("the username <input id=\"username\"> opts out of the app-wide ring via focus-ring-off", () => {
    expect(inputWith(PROFILE, 'id="username"').includes("focus-ring-off")).toBe(true);
  });

  it("the date-time field's masked <input> opts out of the app-wide ring via focus-ring-off", () => {
    // The masked text input carries the yyyy/mm/dd HH:mm placeholder.
    expect(inputWith(PICKER, 'placeholder="yyyy/mm/dd HH:mm"').includes("focus-ring-off")).toBe(true);
  });

  it("globals.css carries the UNLAYERED .focus-ring-off:focus-visible override that actually wins", () => {
    // The override must exist AND set outline:none — this is what beats the app-wide
    // unlayered :focus-visible rule (a layered Tailwind utility could not).
    expect(
      /\.focus-ring-off:focus-visible\s*\{[^}]*outline:\s*none/.test(GLOBALS),
      "globals.css must define .focus-ring-off:focus-visible { outline: none } (unlayered)",
    ).toBe(true);
    // And it must NOT be wrapped in an @layer (unlayered, so it beats the app-wide rule).
    const ruleIdx = GLOBALS.indexOf(".focus-ring-off:focus-visible");
    const before = GLOBALS.slice(0, ruleIdx);
    const lastLayerOpen = before.lastIndexOf("@layer");
    if (lastLayerOpen !== -1) {
      // If there's an @layer before it, that block must already be closed.
      const opens = (before.slice(lastLayerOpen).match(/\{/g) ?? []).length;
      const closes = (before.slice(lastLayerOpen).match(/\}/g) ?? []).length;
      expect(closes, "the .focus-ring-off rule is NOT inside an open @layer block").toBeGreaterThanOrEqual(opens);
    }
  });

  it("both wrappers keep focus-within:border-iris as the single focus indicator", () => {
    expect(PROFILE.includes("focus-within:border-iris")).toBe(true);
    expect(PICKER.includes("focus-within:border-iris")).toBe(true);
  });
});
