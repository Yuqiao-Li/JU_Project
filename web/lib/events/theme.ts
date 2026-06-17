/**
 * Event theme + effect presets (task 2.2b).
 *
 * The host picks an accent color and an optional moderate effect for their event.
 * Both are constrained to a small known set: the form renders these options and
 * the schema validates against them, so a forged POST can never write junk into
 * `events.theme` / `events.effect`. Kept deliberately small — DESIGN-TONE: a
 * decent implementation, not a pile of effects ("不堆砌").
 *
 * Colors are tuned for the product's dark plum-ink base (see globals.css): social,
 * warm, dark-friendly. The default mirrors the app's primary accent (coral).
 */

export interface ThemeSwatch {
  key: ThemeKey;
  label: string;
  /** Accent hex used for the swatch + the event's accent surfaces. */
  hex: string;
}

export const THEME_SWATCHES = [
  { key: "coral", label: "Coral", hex: "#ff6a5c" },
  { key: "amber", label: "Amber", hex: "#ffb14e" },
  { key: "iris", label: "Iris", hex: "#9b8cff" },
  { key: "emerald", label: "Emerald", hex: "#34d399" },
  { key: "rose", label: "Rose", hex: "#fb7185" },
  { key: "sky", label: "Sky", hex: "#38bdf8" },
] as const satisfies ReadonlyArray<{ key: string; label: string; hex: string }>;

export type ThemeKey = (typeof THEME_SWATCHES)[number]["key"];

export const THEME_KEYS = THEME_SWATCHES.map((s) => s.key) as ThemeKey[];

export const DEFAULT_THEME: ThemeKey = "coral";

export interface EffectPreset {
  key: EffectKey;
  label: string;
}

/** "none" plus a handful of tasteful, reduced-motion-friendly presets. */
export const EFFECT_PRESETS = [
  { key: "none", label: "None" },
  { key: "confetti", label: "Confetti" },
  { key: "glow", label: "Glow" },
  { key: "balloons", label: "Balloons" },
] as const satisfies ReadonlyArray<{ key: string; label: string }>;

export type EffectKey = (typeof EFFECT_PRESETS)[number]["key"];

export const EFFECT_KEYS = EFFECT_PRESETS.map((e) => e.key) as EffectKey[];

/** Constrain a raw form value to a known theme color; unknown → the default. */
export function parseThemeColor(raw: string): ThemeKey {
  return (THEME_KEYS as readonly string[]).includes(raw) ? (raw as ThemeKey) : DEFAULT_THEME;
}

/**
 * Constrain a raw form value to a known effect. "none" and any unknown value
 * collapse to null, which is what gets stored (no effect).
 */
export function parseEffect(raw: string): EffectKey | null {
  if (!(EFFECT_KEYS as readonly string[]).includes(raw)) return null;
  return raw === "none" ? null : (raw as EffectKey);
}

/** Look up a swatch by key, falling back to the default. */
export function themeSwatch(key: string): ThemeSwatch {
  return THEME_SWATCHES.find((s) => s.key === key) ?? THEME_SWATCHES[0];
}

/** Read the theme color out of a stored `theme` jsonb value; unknown → default. */
export function themeColorFromJson(value: unknown): ThemeKey {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const color = (value as Record<string, unknown>).color;
    if (typeof color === "string") return parseThemeColor(color);
  }
  return DEFAULT_THEME;
}
