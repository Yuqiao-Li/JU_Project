/**
 * Event category presets (Step-10A Task 3 — the 建局 functional layer).
 *
 * Building an event lets the host pick a CATEGORY (建局选分类). The category does two
 * things (docs/prd/event-create.md 实现逻辑):
 *   1. it sediments a backend `events.category` for future discovery/recommendation;
 *   2. it drives which auto-generated 局卡 designs the platform offers (the per-card
 *      picker + previews are Step-10B — this layer only persists the choice).
 *
 * Mirrors the config-list shape of `theme.ts`: a small known set rendered by the form
 * and validated by the schema, so a forged POST can never write junk into
 * `events.category`. Category is OPTIONAL — an absent/unknown value collapses to the
 * generic default, which maps to the default 局卡.
 *
 * PLACEHOLDER LABELS: the final 黑话 category names (and their tone) are bound to the
 * brand PDF and land in Step-10B. These are neutral stand-ins so the selector works
 * end-to-end now; renaming them later is a pure label change (the `key`s — what's
 * stored — stay stable).
 *
 * Kept pure (no `server-only`, no DB, no React) so it unit-tests without a database and
 * is shared by the form, the schema boundary, and any later card logic.
 */

export interface CategoryPreset {
  key: CategoryKey;
  /** Placeholder label (final 黑话 wording is Step-10B). */
  label: string;
}

/** The generic/default category — used when the host doesn't pick one. */
export const DEFAULT_CATEGORY = "generic" as const;

export const CATEGORY_PRESETS = [
  { key: "generic", label: "General" },
  { key: "meal", label: "Meal" },
  { key: "drinks", label: "Drinks" },
  { key: "party", label: "Party" },
  { key: "outdoors", label: "Outdoors" },
  { key: "game", label: "Game night" },
  { key: "study", label: "Study / work" },
] as const satisfies ReadonlyArray<{ key: string; label: string }>;

export type CategoryKey = (typeof CATEGORY_PRESETS)[number]["key"];

export const CATEGORY_KEYS = CATEGORY_PRESETS.map((c) => c.key) as CategoryKey[];

/** Constrain a raw form value to a known category; absent/unknown → the default. */
export function parseCategory(raw: string): CategoryKey {
  return (CATEGORY_KEYS as readonly string[]).includes(raw) ? (raw as CategoryKey) : DEFAULT_CATEGORY;
}

/** Look up a preset by key, falling back to the generic default. */
export function categoryPreset(key: string): CategoryPreset {
  return CATEGORY_PRESETS.find((c) => c.key === key) ?? CATEGORY_PRESETS[0];
}
