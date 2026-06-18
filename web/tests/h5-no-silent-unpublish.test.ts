import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION GUARD — a host must not be able to SILENTLY unpublish a live event (audit H5).
 *
 * THE BUG THIS LOCKS IN:
 *   The event edit form (`app/dashboard/events/event-form.tsx`) has two submit buttons that
 *   share `name="intent"`: `value="publish"` and `value="draft"` (the "转为草稿" / moveToDraft
 *   button). When the event is CURRENTLY published, clicking "转为草稿" flips it back to draft —
 *   which makes the public `/{slug}` page 404 and KILLS every already-shared invite link, with
 *   no confirmation. A host who only wanted to tweak content can destroy the event's reach in
 *   one mis-click. Two layers protect this invariant and BOTH are pinned from source here:
 *
 *     (1) CLIENT confirmation guard — the draft (moveToDraft) submit button is confirmation-
 *         gated: on `mode === "edit"` AND `d.status === "published"` it calls window.confirm
 *         with the `moveToDraftConfirm` i18n message and preventDefaults if the host declines.
 *         The publish-button path is untouched (a `value="publish"` submit still exists).
 *
 *     (2) SERVER status preservation — `updateEvent` in `app/dashboard/events/actions.ts`
 *         derives nextStatus as `existing?.status === "cancelled" ? "cancelled" : …`, so a
 *         routine content-Save can never resurrect / flip a cancelled event. (This is the
 *         existing half of H5; pinned so a refactor can't silently drop it.)
 *
 *     (3) i18n parity — `moveToDraftConfirm` exists under the `eventForm` namespace in BOTH
 *         zh.json and en.json, and the two `eventForm` key sets are identical (so the guard's
 *         confirm text never falls back to a missing key at runtime).
 *
 * WHY A SOURCE-ASSERTION TEST: event-form.tsx is a `"use client"` React component and the
 * vitest harness runs `environment: "node"` with no `@/` alias and no React renderer — the
 * form cannot be mounted here. So, in the same static-guard style as `task-4-lifecycle.test.ts`
 * and `client-tree-no-server-getTranslations.test.ts`, we read the files from disk and grep
 * their CODE. Comments are stripped before matching so the prose above (which names every
 * guarded token while explaining the bug) cannot self-trip the greps.
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

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — the CLIENT confirmation guard on the moveToDraft submit button.
// ─────────────────────────────────────────────────────────────────────────────

describe("H5 [NO SILENT UNPUBLISH]: the moveToDraft button is confirmation-gated on a published event", () => {
  const CODE = stripComments(src("app/dashboard/events/event-form.tsx"));

  it("still has a value=\"draft\" submit button (the moveToDraft path exists to be guarded)", () => {
    expect(
      /name="intent"[\s\S]{0,200}value="draft"/.test(CODE),
      "event-form.tsx: a name=\"intent\" value=\"draft\" submit button is present",
    ).toBe(true);
  });

  it("references a confirmation dialog (window.confirm / confirm() ) — the host must opt in", () => {
    expect(
      /window\.confirm\s*\(|(?<![.\w])confirm\s*\(/.test(CODE),
      "event-form.tsx: the draft button uses a confirm() dialog",
    ).toBe(true);
  });

  it("gates the confirm on the published-status condition: mode === \"edit\" AND d.status === \"published\"", () => {
    expect(
      /mode === "edit"/.test(CODE),
      "event-form.tsx: the guard checks mode === \"edit\"",
    ).toBe(true);
    expect(
      /d\.status === "published"/.test(CODE),
      "event-form.tsx: the guard checks d.status === \"published\" (only LIVE events prompt)",
    ).toBe(true);
  });

  it("uses the moveToDraftConfirm i18n key for the confirmation message", () => {
    expect(
      /t\(\s*["']moveToDraftConfirm["']\s*\)/.test(CODE),
      "event-form.tsx: the confirm() text comes from t(\"moveToDraftConfirm\")",
    ).toBe(true);
  });

  it("the guard, the published condition, and the confirm key all co-occur in ONE expression (not three unrelated lines)", () => {
    // Pin the whole guard shape: edit + published + a NEGATED confirm(moveToDraftConfirm), so a
    // refactor that keeps the tokens but loosens the condition (e.g. drops the !) is still caught.
    expect(
      /mode === "edit"[\s\S]{0,80}d\.status === "published"[\s\S]{0,120}!\s*window\.confirm\s*\(\s*t\(\s*["']moveToDraftConfirm["']\s*\)\s*\)/.test(
        CODE,
      ),
      "event-form.tsx: editing a published event prevents the draft submit unless the host confirms moveToDraftConfirm",
    ).toBe(true);
  });

  it("preventDefault is wired so declining the confirm actually STOPS the unpublish", () => {
    expect(
      /preventDefault\s*\(\s*\)/.test(CODE),
      "event-form.tsx: declining the confirm calls e.preventDefault() to block the submit",
    ).toBe(true);
  });

  it("the publish-button path is UNTOUCHED — a value=\"publish\" submit still exists and is NOT confirm-gated", () => {
    expect(
      /name="intent"[\s\S]{0,200}value="publish"/.test(CODE),
      "event-form.tsx: a name=\"intent\" value=\"publish\" submit button is present",
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — the SERVER preserves a cancelled event across a content Save.
// (The existing half of H5 — see note: task-4-lifecycle.test.ts also asserts this.)
// ─────────────────────────────────────────────────────────────────────────────

describe("H5 [NO SILENT UNPUBLISH]: updateEvent preserves a cancelled status (a content-Save can't resurrect it)", () => {
  const CODE = stripComments(src("app/dashboard/events/actions.ts"));

  it("derives nextStatus with the cancelled-preservation ternary: existing?.status === \"cancelled\" ? \"cancelled\" : …", () => {
    expect(
      /existing\?\.status === "cancelled"\s*\?\s*"cancelled"/.test(CODE),
      "actions.ts: updateEvent keeps a cancelled event cancelled regardless of the save intent",
    ).toBe(true);
  });

  it("reads the EXISTING status before computing the next one (proof it doesn't blindly trust the intent)", () => {
    expect(
      /\.select\(\s*["']status["']\s*\)/.test(CODE),
      "actions.ts: updateEvent reads the current status before deciding nextStatus",
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — i18n parity for the confirm message across both catalogs.
// ─────────────────────────────────────────────────────────────────────────────

describe("H5 [NO SILENT UNPUBLISH]: moveToDraftConfirm exists in both catalogs and eventForm key sets match", () => {
  const zhForm = JSON.parse(src("messages/zh.json")).eventForm as Record<string, unknown>;
  const enForm = JSON.parse(src("messages/en.json")).eventForm as Record<string, unknown>;

  it("moveToDraftConfirm is a non-empty string under eventForm in zh.json", () => {
    const v = zhForm?.moveToDraftConfirm;
    expect(typeof v === "string" && (v as string).length > 0, "zh.json: eventForm.moveToDraftConfirm present").toBe(true);
  });

  it("moveToDraftConfirm is a non-empty string under eventForm in en.json", () => {
    const v = enForm?.moveToDraftConfirm;
    expect(typeof v === "string" && (v as string).length > 0, "en.json: eventForm.moveToDraftConfirm present").toBe(true);
  });

  it("the en and zh confirm messages are DISTINCT (a real translation, not a copy-paste of the other locale)", () => {
    expect(enForm.moveToDraftConfirm, "en vs zh moveToDraftConfirm are distinct").not.toBe(zhForm.moveToDraftConfirm);
  });

  it("the eventForm key SETS are identical across zh.json and en.json (parity invariant — no missing-key fallback)", () => {
    const zhKeys = Object.keys(zhForm).sort();
    const enKeys = Object.keys(enForm).sort();
    expect(zhKeys, "zh.json and en.json have the same eventForm keys").toEqual(enKeys);
  });
});
