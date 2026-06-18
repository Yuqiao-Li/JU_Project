import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION GUARD — server-only `getTranslations` must never be used inside the CLIENT tree.
 *
 * THE BUG THIS LOCKS IN (production 500):
 *   The public event page (`app/[slug]/...`) crashed in prod with
 *       Error: 'getTranslations' is not supported in Client Components
 *   Root cause: `components/events/guest-list.tsx` was an async Server Component that called
 *   `getTranslations` (the server-only `next-intl/server` API), but it is rendered as a child
 *   slot of the CLIENT shell `app/[slug]/event-client.tsx` (`"use client"`). Anything that
 *   ends up in the client tree must use the `useTranslations` HOOK from `next-intl`, never the
 *   server-only `getTranslations`. The crash only surfaced once an UNLOCKED viewer (e.g. the
 *   logged-in host) made the guest list actually render — i.e. it slipped past a casual smoke
 *   test. It is now fixed (guest-list.tsx is `"use client"` + `useTranslations`).
 *
 * THE INVARIANT: components rendered inside the client tree must NOT import/use
 * `getTranslations` or import from `next-intl/server`. This is a pure SOURCE-GREP test
 * (Node `fs`/`path`, NO DB, NO React rendering) in the same static-guard style as the
 * source assertions in `task-4-lifecycle.test.ts`.
 *
 * NOTE on comment-stripping: `guest-list.tsx`'s own doc comment NAMES `getTranslations` and
 * `next-intl/server` while explaining this very bug. A naive raw substring grep would
 * self-trip on that prose. So the broad/code guards strip block + line comments first and
 * match against the CODE only — a future offender that actually IMPORTS or CALLS the
 * server API is still caught, while honest prose about the bug is allowed.
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

const EVENTS_DIR_REL = "components/events";
const EVENTS_DIR_ABS = fileURLToPath(new URL(`../${EVENTS_DIR_REL}/`, import.meta.url));

/** Every .ts/.tsx file under components/events (the presentational, client-slot components). */
const eventComponentFiles: readonly string[] = readdirSync(EVENTS_DIR_ABS)
  .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
  .sort();

describe("CLIENT-TREE GUARD: components/events never use server-only getTranslations / next-intl/server", () => {
  // Sanity: the directory exists and actually has files, so an empty glob can't silently pass.
  it("the components/events directory is non-empty (the broad guard actually has files to check)", () => {
    expect(eventComponentFiles.length, "components/events has .ts/.tsx files to guard").toBeGreaterThan(0);
    // guest-list.tsx (the historical offender) MUST be among the files this guard sweeps.
    expect(eventComponentFiles, "the historically-offending file is included in the sweep").toContain(
      "guest-list.tsx",
    );
  });

  // ── Assertion #1: BROAD guard over EVERY file under components/events ──────────────────
  // These are all presentational components rendered in client slots; none may reach for the
  // server-only translation API. Iterating the whole directory means a NEW offender file is
  // caught automatically, not just the one we already fixed.
  it.each(eventComponentFiles)(
    "components/events/%s does not use getTranslations and does not import next-intl/server",
    (file) => {
      const code = stripComments(src(`${EVENTS_DIR_REL}/${file}`));
      expect(
        code.includes("getTranslations"),
        `components/events/${file}: must NOT use the server-only getTranslations (use the useTranslations hook)`,
      ).toBe(false);
      expect(
        code.includes("next-intl/server"),
        `components/events/${file}: must NOT import from next-intl/server (client tree)`,
      ).toBe(false);
    },
  );
});

// ── Assertion #2: SPECIFIC guard on the fixed file (guest-list.tsx) ──────────────────────
describe("CLIENT-TREE GUARD: guest-list.tsx is a fixed client component (the historical offender)", () => {
  const RAW = src(`${EVENTS_DIR_REL}/guest-list.tsx`);
  const CODE = stripComments(RAW);

  it("declares the \"use client\" directive at the top (it lives in the client tree)", () => {
    // First non-empty line is the directive.
    const firstNonEmpty = RAW.split("\n").find((l) => l.trim().length > 0) ?? "";
    expect(/^["']use client["'];?\s*$/.test(firstNonEmpty.trim()), "guest-list.tsx: first line is \"use client\"").toBe(
      true,
    );
    expect(/^["']use client["'];?/m.test(RAW), "guest-list.tsx: \"use client\" directive present").toBe(true);
  });

  it("imports the client useTranslations hook from next-intl (not the server API)", () => {
    expect(
      /import\s*\{[^}]*\buseTranslations\b[^}]*\}\s*from\s*["']next-intl["']/.test(CODE),
      "guest-list.tsx: imports useTranslations from 'next-intl'",
    ).toBe(true);
  });

  it("does NOT use getTranslations nor import next-intl/server (code, comments excluded)", () => {
    expect(CODE.includes("getTranslations"), "guest-list.tsx code: no getTranslations").toBe(false);
    expect(CODE.includes("next-intl/server"), "guest-list.tsx code: no next-intl/server import").toBe(false);
  });
});

// ── Assertion #3: targeted guard on the [slug] client shell + its rendered view ──────────
describe("CLIENT-TREE GUARD: the [slug] client shell stays a client boundary with no server translation API", () => {
  const RAW = src("app/[slug]/event-client.tsx");
  const CODE = stripComments(RAW);

  it("event-client.tsx is a \"use client\" boundary", () => {
    expect(/^["']use client["'];?/m.test(RAW), "event-client.tsx: \"use client\" directive present").toBe(true);
  });

  it("event-client.tsx uses the client hook and never the server-only getTranslations / next-intl/server", () => {
    // It drives translations via the hook…
    expect(
      /import\s*\{[^}]*\buseTranslations\b[^}]*\}\s*from\s*["']next-intl["']/.test(CODE),
      "event-client.tsx: uses the useTranslations hook",
    ).toBe(true);
    // …and never the server API (which would throw in this client tree).
    expect(CODE.includes("getTranslations"), "event-client.tsx code: no getTranslations").toBe(false);
    expect(CODE.includes("next-intl/server"), "event-client.tsx code: no next-intl/server import").toBe(false);
  });

  it("guest-list.tsx — the slot event-client.tsx renders for the guest list — uses the hook (catches the exact prod crash)", () => {
    // event-client.tsx renders <GuestList/>; that component must translate via the hook.
    expect(RAW.includes("GuestList"), "event-client.tsx renders the GuestList slot").toBe(true);
    const guestListCode = stripComments(src(`${EVENTS_DIR_REL}/guest-list.tsx`));
    expect(
      /\buseTranslations\b/.test(guestListCode),
      "the rendered GuestList uses useTranslations (hook), so the prod 500 can't recur",
    ).toBe(true);
    expect(guestListCode.includes("getTranslations"), "the rendered GuestList has no getTranslations").toBe(false);
  });
});
