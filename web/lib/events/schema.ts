import { z } from "zod";

import { parseEffect, parseThemeColor, type ThemeKey } from "./theme";

/**
 * Validation boundary for the create/edit event form (tasks 2.2a + 2.2b).
 *
 * Everything a host can type flows through `parseEventForm` before it reaches
 * Supabase — zod at the boundary (CLAUDE.md). FormData values arrive as strings
 * (or absent, for unchecked checkboxes), so we normalise here: empty text → null,
 * checkboxes → boolean, numerics → int. Task 2.2b adds the cover image URL, the
 * theme color (constrained to a known palette), the moderate effect preset, and
 * the display-only chip_in link + note. The remaining 🟡 placeholder columns
 * (lat/lng, photo upload, approval, anonymise) keep their DB defaults.
 */

export type EventIntent = "draft" | "publish";

/** Normalised, ready-to-write event fields (column-named). */
export interface EventInput {
  title: string;
  description: string | null;
  date_tbd: boolean;
  starts_at: string | null;
  ends_at: string | null;
  location_text: string | null;
  location_url: string | null;
  location_city: string | null;
  visibility: "public" | "private";
  capacity: number | null;
  allow_plus_ones: boolean;
  max_plus_ones: number;
  rsvp_enabled: boolean;
  // Task 2.2b — look + chip-in.
  cover_image_url: string | null;
  theme: { color: ThemeKey };
  effect: string | null;
  chip_in_url: string | null;
  chip_in_note: string | null;
}

/**
 * What to do with the password. The form never sees the stored hash, so editing
 * is three-state: keep it as-is, set a new one (bcrypted server-side via the
 * set_event_password RPC), or clear it.
 */
export interface PasswordChange {
  action: "keep" | "set" | "clear";
  value: string;
}

export interface ParsedEventForm {
  input: EventInput;
  intent: EventIntent;
  password: PasswordChange;
}

export type ParseResult =
  | { ok: true; value: ParsedEventForm }
  | { ok: false; message: string };

/** "on" (checkbox), "true", "1" → true; anything else (incl. absent) → false. */
function bool(v: FormDataEntryValue | null): boolean {
  return v === "on" || v === "true" || v === "1";
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

const titleSchema = z
  .string()
  .trim()
  .min(1, "Give your event a name.")
  .max(120, "Keep the title under 120 characters.");

const descriptionSchema = z.string().max(4000, "That description is a bit long — trim it down.");
const citySchema = z.string().max(120, "That city name is too long.");
const addressSchema = z.string().max(500, "That address is too long.");
const urlSchema = z.url("Enter a full link, like https://maps.app/…").max(2000);
const chipNoteSchema = z.string().max(280, "Keep the chip-in note short.");

/** Only http(s) links — these get rendered as links/images, so reject javascript: etc. */
const httpsOnly = (msg: string) => z.url(msg).max(2000).refine((u) => /^https?:\/\//i.test(u), { message: msg });
const chipUrlSchema = httpsOnly("Enter a full link, like https://venmo.com/…");
const coverUrlSchema = httpsOnly("That cover image link looks off.");

const VISIBILITIES = ["public", "private"] as const;

/** Datetime-local strings ("2026-06-20T19:30"); empty → null. Must be parseable. */
function parseDateTime(raw: string, label: string): string | null | { error: string } {
  const v = raw.trim();
  if (v === "") return null;
  if (Number.isNaN(Date.parse(v))) return { error: `That ${label} doesn't look like a valid date and time.` };
  return v;
}

/**
 * Parse + validate the whole form. Returns either the normalised, write-ready
 * payload or the first human-facing error message.
 */
export function parseEventForm(formData: FormData): ParseResult {
  const title = titleSchema.safeParse(str(formData.get("title")));
  if (!title.success) return { ok: false, message: title.error.issues[0]?.message ?? "Check the title." };

  const rawDescription = str(formData.get("description")).trim();
  if (rawDescription) {
    const parsed = descriptionSchema.safeParse(rawDescription);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the description." };
  }

  const visParsed = z.enum(VISIBILITIES).safeParse(str(formData.get("visibility")));
  if (!visParsed.success) return { ok: false, message: "Choose who can see this event." };

  const dateTbd = bool(formData.get("date_tbd"));
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (!dateTbd) {
    const s = parseDateTime(str(formData.get("starts_at")), "start time");
    if (s && typeof s === "object") return { ok: false, message: s.error };
    startsAt = s as string | null;
    const e = parseDateTime(str(formData.get("ends_at")), "end time");
    if (e && typeof e === "object") return { ok: false, message: e.error };
    endsAt = e as string | null;
    if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
      return { ok: false, message: "The end time can't be before the start time." };
    }
  }

  const rawCity = str(formData.get("location_city")).trim();
  if (rawCity && !citySchema.safeParse(rawCity).success) {
    return { ok: false, message: "That city name is too long." };
  }
  const rawAddress = str(formData.get("location_text")).trim();
  if (rawAddress && !addressSchema.safeParse(rawAddress).success) {
    return { ok: false, message: "That address is too long." };
  }
  const rawUrl = str(formData.get("location_url")).trim();
  if (rawUrl) {
    const parsed = urlSchema.safeParse(rawUrl);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the location link." };
  }

  let capacity: number | null = null;
  const rawCapacity = str(formData.get("capacity")).trim();
  if (rawCapacity) {
    const n = Number(rawCapacity);
    if (!Number.isInteger(n) || n < 1) return { ok: false, message: "Capacity must be a whole number of 1 or more." };
    capacity = n;
  }

  const allowPlusOnes = bool(formData.get("allow_plus_ones"));
  let maxPlusOnes = 1;
  if (allowPlusOnes) {
    const n = Number(str(formData.get("max_plus_ones")).trim() || "1");
    if (!Number.isInteger(n) || n < 1) return { ok: false, message: "Plus-ones per guest must be a whole number of 1 or more." };
    maxPlusOnes = n;
  }

  // Look: theme color + effect are constrained to known presets (forged values
  // fail closed to default/null), so the DB only ever sees valid choices.
  const themeColor = parseThemeColor(str(formData.get("theme_color")));
  const effect = parseEffect(str(formData.get("effect")));

  // The cover URL is produced by the uploader (it points at our public bucket),
  // but we still validate it's a well-formed http(s) URL before persisting.
  let coverImageUrl: string | null = null;
  const rawCover = str(formData.get("cover_image_url")).trim();
  if (rawCover) {
    const parsed = coverUrlSchema.safeParse(rawCover);
    if (!parsed.success) return { ok: false, message: "That cover image link looks off. Re-upload the cover." };
    coverImageUrl = parsed.data;
  }

  // chip_in is display-only metadata (D: 纯展示): an optional link + short note.
  let chipInUrl: string | null = null;
  const rawChipUrl = str(formData.get("chip_in_url")).trim();
  if (rawChipUrl) {
    const parsed = chipUrlSchema.safeParse(rawChipUrl);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the chip-in link." };
    chipInUrl = parsed.data;
  }
  let chipInNote: string | null = null;
  const rawChipNote = str(formData.get("chip_in_note")).trim();
  if (rawChipNote) {
    const parsed = chipNoteSchema.safeParse(rawChipNote);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the chip-in note." };
    chipInNote = parsed.data;
  }

  const intent: EventIntent = str(formData.get("intent")) === "publish" ? "publish" : "draft";

  // Password is three-state. A "clear" checkbox wins; otherwise a non-empty value
  // means "set", and an empty value means "keep" (the host didn't touch it).
  let password: PasswordChange = { action: "keep", value: "" };
  if (bool(formData.get("clear_password"))) {
    password = { action: "clear", value: "" };
  } else {
    const pw = str(formData.get("password"));
    if (pw.trim().length > 0) {
      if (pw.length < 4) return { ok: false, message: "Use a password of at least 4 characters." };
      if (pw.length > 128) return { ok: false, message: "That password is too long." };
      password = { action: "set", value: pw };
    }
  }

  return {
    ok: true,
    value: {
      intent,
      password,
      input: {
        title: title.data,
        description: rawDescription || null,
        date_tbd: dateTbd,
        starts_at: startsAt,
        ends_at: endsAt,
        location_text: rawAddress || null,
        location_url: rawUrl || null,
        location_city: rawCity || null,
        visibility: visParsed.data,
        capacity,
        allow_plus_ones: allowPlusOnes,
        max_plus_ones: maxPlusOnes,
        rsvp_enabled: bool(formData.get("rsvp_enabled")),
        cover_image_url: coverImageUrl,
        theme: { color: themeColor },
        effect,
        chip_in_url: chipInUrl,
        chip_in_note: chipInNote,
      },
    },
  };
}
