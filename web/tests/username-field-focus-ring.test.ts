import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION GUARD — the username field must not paint a DOUBLED focus ring (#4).
 *
 * THE BUG THIS LOCKS IN:
 *   In `app/dashboard/settings/profile-form.tsx` the username `<input>` lives INSIDE a
 *   container div that already shows the single focus indicator via `focus-within:border-iris`
 *   (the iris border lights up when anything inside is focused). The bare `<input>`, however,
 *   ALSO got the browser/Tailwind default focus-visible outline — so focusing the field painted
 *   a SECOND, offset focus ring INSIDE the bordered container: two competing indicators, ugly.
 *   The fix adds `focus-visible:outline-none` to the input so the container's
 *   `focus-within:border-iris` is the ONE focus indicator.
 *
 * THE INVARIANT (pinned here so a future edit can't re-introduce the doubled ring):
 *   1. the username `<input id="username" …>` className contains `focus-visible:outline-none`.
 *   2. its wrapping container div still carries `focus-within:border-iris` (the single indicator).
 *
 * Pure SOURCE-GREP (Node `fs`, NO DB, NO React render — vitest runs `node`), in the same
 * comment-stripped static-guard style as `client-tree-no-server-getTranslations.test.ts`.
 * Comments are stripped first so prose that NAMES these class tokens can't self-trip the grep.
 */

/** Read an implementation source file by repo-relative path (relative to this test file). */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

/** Strip block + line comments so we grep CODE (real className strings), not prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep the char before "//")
}

const PROFILE_FORM_REL = "app/dashboard/settings/profile-form.tsx";
const CODE = stripComments(src(PROFILE_FORM_REL));

describe("FOCUS-RING GUARD: the username field shows ONE focus indicator, not a doubled ring (#4)", () => {
  // Pull the username <input …> element (id="username") out of the code so the className
  // assertion is scoped to THAT input — not, e.g., the display_name input above it.
  const usernameInput = (() => {
    const idIdx = CODE.indexOf('id="username"');
    expect(idIdx, "profile-form.tsx contains the username input (id=\"username\")").toBeGreaterThan(-1);
    // The <input …/> that carries id="username": from the nearest "<input" before it to the
    // next "/>" after it.
    const openIdx = CODE.lastIndexOf("<input", idIdx);
    const closeIdx = CODE.indexOf("/>", idIdx);
    expect(openIdx, "found the opening <input of the username field").toBeGreaterThan(-1);
    expect(closeIdx, "found the self-closing /> of the username field").toBeGreaterThan(idIdx);
    return CODE.slice(openIdx, closeIdx);
  })();

  it("the username <input id=\"username\"> kills its own focus-visible outline (no second offset ring)", () => {
    expect(
      usernameInput.includes("focus-visible:outline-none"),
      "username input className must contain focus-visible:outline-none so it doesn't paint a second focus ring",
    ).toBe(true);
  });

  it("the wrapping container still carries focus-within:border-iris (the SINGLE focus indicator is preserved)", () => {
    expect(
      CODE.includes("focus-within:border-iris"),
      "the username field's container div must keep focus-within:border-iris as the one focus indicator",
    ).toBe(true);
  });
});
