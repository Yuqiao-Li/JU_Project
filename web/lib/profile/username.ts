import { z } from "zod";

/**
 * Username rules for the Organizer Profile handle (`/u/[username]`).
 *
 * The DB unique index `profiles_username_key` is the single authority on
 * uniqueness (SCHEMA §1 / TASKS 2.1: "username 唯一靠 DB 索引,设置 UI 查仅提示").
 * This module is only the *shape* check + normalization, shared by the settings
 * form (advisory) and the server action (zod boundary, CLAUDE.md coding stds).
 * It never decides availability — that's the index's job under a real write.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/**
 * Handles that collide with top-level routes or would be confusing as a public
 * profile. Uniqueness is the index's job; this is just UX hygiene.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin", "administrator", "root", "support", "help", "about", "contact",
  "login", "logout", "signin", "signout", "signup", "register", "auth",
  "dashboard", "settings", "account", "profile", "api", "u", "new", "edit",
  "event", "events", "host", "guest", "me", "you", "ju", "partiful", "null",
  "undefined", "static", "public", "assets", "favicon",
]);

/** Trim + lowercase. Usernames are case-insensitive handles. */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

// Starts and ends with a letter or digit; the middle may contain hyphens or
// underscores. No spaces, dots, slashes, symbols, or emoji.
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/**
 * Zod schema for the username field. Normalizes first, then validates shape, so
 * server-side parsing and the advisory UI check agree on one source of truth.
 */
export const usernameSchema = z
  .string()
  .transform(normalizeUsername)
  .pipe(
    z
      .string()
      .min(USERNAME_MIN, `Usernames need at least ${USERNAME_MIN} characters.`)
      .max(USERNAME_MAX, `Usernames can be at most ${USERNAME_MAX} characters.`)
      .regex(
        USERNAME_PATTERN,
        "Use letters, numbers, hyphens or underscores, starting and ending with a letter or number.",
      )
      .refine((v) => !RESERVED_USERNAMES.has(v), "That username is reserved."),
  );

/** Display name: free text, just bounded and trimmed. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Add a name people will recognize.")
  .max(80, "That name is a little too long.");

export type UsernameResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate + normalize a username, returning a single human-readable error on
 * failure. Used by the advisory availability route and the settings form.
 */
export function validateUsername(input: string): UsernameResult {
  const parsed = usernameSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues[0]?.message ?? "That username won't work." };
}
