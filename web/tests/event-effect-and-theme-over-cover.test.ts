import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseEffect } from "../lib/events/theme";

/**
 * REGRESSION GUARD — Round-2 §7.2: the event `effect` is a LIVE feature again, and the
 * host theme `accent` survives a cover image.
 *
 * TWO BUGS THIS LOCKS IN:
 *
 *  1. DEAD FEATURE — `events.effect` (confetti | glow | balloons) was form-selectable and
 *     stored/round-tripped through the DB, but NOTHING ever drew it. The fix adds a purely
 *     presentational overlay `components/events/event-effect.tsx` (EventEffect) and renders
 *     it from the Hero in `app/[slug]/event-view.tsx`, with CSS keyframes in `app/globals.css`.
 *     This guard asserts the overlay is (a) actually imported + rendered with `event.effect`,
 *     (b) SSR/hydration-safe (no Math.random / Date — those would desync server vs. client
 *     markup), (c) NOT pulling a server-only translation API into the client tree, (d) non-
 *     interactive + a11y-hidden, and (e) fail-closed (forged effect → render nothing).
 *
 *  2. THEME-OVER-COVER — setting a cover image used to ERASE the host's accent (the cover
 *     swapped out the accent gradient, so a themed event looked un-themed). The fix gives the
 *     Hero an always-present accent ring + glow via a `boxShadow` that interpolates `accent`,
 *     so the theme reads through even with a cover. This guard asserts that boxShadow exists.
 *
 * WHY MOSTLY SOURCE-ASSERTION: the vitest harness is `environment: "node"` with NO `@/` alias
 * and CANNOT render React, so the component itself is not importable/renderable here. We grep
 * the CODE of the relevant files (Node `fs`, comment-stripped so a file's own doc comment that
 * NAMES a banned token can't self-trip the grep) — mirroring
 * `tests/client-tree-no-server-getTranslations.test.ts`. The ONE vitest-importable bit of real
 * logic — `parseEffect` in `lib/events/theme.ts` — gets a true pure-function unit test below
 * (imported via RELATIVE path since there's no `@/` alias in the harness).
 */

/** Read an implementation source file by repo-relative path (relative to this test file). */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

/** Strip `/* … *\/` block comments and `// …` line comments so we grep CODE, not prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep the char before "//", avoids eating "https://")
}

const EVENT_VIEW_REL = "app/[slug]/event-view.tsx";
const EVENT_EFFECT_REL = "components/events/event-effect.tsx";
const GLOBALS_CSS_REL = "app/globals.css";

// ── A. The effect feature is actually rendered (the dead feature stays alive) ──────────────
describe("§7.2 FIX 1 — event-view.tsx renders the EventEffect overlay with event.effect", () => {
  const CODE = stripComments(src(EVENT_VIEW_REL));

  it("imports EventEffect from @/components/events/event-effect", () => {
    expect(
      /import\s*\{[^}]*\bEventEffect\b[^}]*\}\s*from\s*["']@\/components\/events\/event-effect["']/.test(CODE),
      "event-view.tsx must import EventEffect from @/components/events/event-effect",
    ).toBe(true);
  });

  it("renders <EventEffect …> (the overlay is actually drawn, not just imported)", () => {
    expect(
      /<EventEffect[\s/>]/.test(CODE),
      "event-view.tsx must render a <EventEffect … /> element",
    ).toBe(true);
  });

  it("passes the stored event.effect into the overlay (the round-tripped value is what's drawn)", () => {
    // The render must reference event.effect — the previously-dead stored value.
    expect(
      /effect=\{\s*event\.effect\s*\}/.test(CODE),
      "event-view.tsx must pass effect={event.effect} to EventEffect",
    ).toBe(true);
  });
});

// ── B. event-effect.tsx is SSR-safe + clean ────────────────────────────────────────────────
describe("§7.2 FIX 1 — event-effect.tsx is SSR-safe, client-tree-safe, fail-closed, non-interactive", () => {
  const RAW = src(EVENT_EFFECT_REL);
  const CODE = stripComments(RAW);

  it("is deterministic / hydration-safe: no Math.random, Date.now, or new Date(", () => {
    expect(CODE.includes("Math.random"), "event-effect.tsx: no Math.random (would desync SSR hydration)").toBe(false);
    expect(CODE.includes("Date.now"), "event-effect.tsx: no Date.now (non-deterministic across server/client)").toBe(
      false,
    );
    expect(CODE.includes("new Date("), "event-effect.tsx: no new Date( (non-deterministic across server/client)").toBe(
      false,
    );
  });

  it("does not pull a server-only translation API into the client tree", () => {
    expect(CODE.includes("next-intl/server"), "event-effect.tsx: must not import next-intl/server").toBe(false);
    expect(CODE.includes("getTranslations"), "event-effect.tsx: must not use server-only getTranslations").toBe(false);
  });

  it("the overlay is non-interactive (pointer-events-none) and a11y-hidden (aria-hidden)", () => {
    expect(CODE.includes("pointer-events-none"), "event-effect.tsx: overlay must be pointer-events-none").toBe(true);
    expect(CODE.includes("aria-hidden"), "event-effect.tsx: overlay must be aria-hidden").toBe(true);
  });

  it("is fail-closed on the effect value: goes through parseEffect and returns null for the non-effect case", () => {
    expect(
      /import\s*\{[^}]*\bparseEffect\b[^}]*\}\s*from\s*["']@\/lib\/events\/theme["']/.test(CODE),
      "event-effect.tsx: must import parseEffect from @/lib/events/theme",
    ).toBe(true);
    expect(CODE.includes("parseEffect"), "event-effect.tsx: must use parseEffect to normalize the effect value").toBe(
      true,
    );
    expect(/return null/.test(CODE), "event-effect.tsx: must `return null` for the non-effect (fail-closed) case").toBe(
      true,
    );
  });

  it("handles all three effects: confetti, glow, balloons", () => {
    expect(CODE.includes("confetti"), "event-effect.tsx: handles confetti").toBe(true);
    expect(CODE.includes("glow"), "event-effect.tsx: handles glow").toBe(true);
    expect(CODE.includes("balloons"), "event-effect.tsx: handles balloons").toBe(true);
  });
});

// ── C. globals.css has the effect keyframes ────────────────────────────────────────────────
describe("§7.2 FIX 1 — globals.css defines the three effect keyframes", () => {
  const CSS = src(GLOBALS_CSS_REL);

  it("declares at least three distinct @keyframes effect-* animations", () => {
    const names = new Set<string>();
    for (const m of CSS.matchAll(/@keyframes\s+(effect-[A-Za-z0-9_-]+)/g)) {
      names.add(m[1]);
    }
    expect(
      names.size,
      `globals.css must define >=3 distinct @keyframes effect-* (found: ${[...names].join(", ") || "none"})`,
    ).toBeGreaterThanOrEqual(3);
  });

  it("defines the specific keyframes the overlay references (effect-glow, effect-confetti, effect-balloon)", () => {
    for (const name of ["effect-glow", "effect-confetti", "effect-balloon"]) {
      expect(
        new RegExp(`@keyframes\\s+${name}\\b`).test(CSS),
        `globals.css must define @keyframes ${name}`,
      ).toBe(true);
    }
  });
});

// ── D. Theme color survives a cover (FIX 2) ────────────────────────────────────────────────
describe("§7.2 FIX 2 — the Hero applies the accent in a boxShadow so the theme survives a cover", () => {
  const CODE = stripComments(src(EVENT_VIEW_REL));

  it("the Hero style has a boxShadow whose value interpolates `accent`", () => {
    expect(CODE.includes("boxShadow"), "event-view.tsx: Hero must set a boxShadow").toBe(true);
    // The accent must be interpolated INTO the boxShadow value (a template literal `${accent…`).
    const boxShadowLine = CODE.split("\n").find((l) => l.includes("boxShadow")) ?? "";
    expect(
      boxShadowLine.includes("${accent"),
      "event-view.tsx: the boxShadow must interpolate ${accent} (so a cover image can't erase the theme)",
    ).toBe(true);
  });
});

// ── E. Pure-logic unit test for parseEffect (the one vitest-importable bit) ─────────────────
describe("§7.2 — parseEffect() passes through real effects and fail-closes forged values", () => {
  it("passes through the three real effects unchanged", () => {
    expect(parseEffect("confetti")).toBe("confetti");
    expect(parseEffect("glow")).toBe("glow");
    expect(parseEffect("balloons")).toBe("balloons");
  });

  it("collapses the explicit none value to null (no effect)", () => {
    expect(parseEffect("none")).toBeNull();
  });

  it("fail-closes unknown / forged values to null (never returns the forged string)", () => {
    for (const forged of ["rm -rf", "alert", "<script>", "CONFETTI", "  glow  ", "", "drop table events"]) {
      expect(parseEffect(forged), `forged value ${JSON.stringify(forged)} must fail-closed to null`).toBeNull();
    }
  });
});
