import { z } from "zod";

import { EVENT_TIME_ZONE } from "./timezone";

/**
 * The Activity-Feed comment list (task 4.1) — the boundary + shaping for the
 * `get_comments` / `add_comment` RPC payloads.
 *
 * THE FEED IS READ-OPEN BUT DESENSITIZED (SCHEMA "get_comments" / D6; TEST-SPEC §4.1).
 * The RPCs already enforce the hard rules in the database — get_comments is open to
 * read (no RSVP) but carries the D3 visibility gate, and BOTH functions expose ONLY
 * id / body / author display_name / is_host / created_at. The author's guest_id /
 * host_id / user_id / contact never leave the database. This module is the front-end's
 * matching boundary: it re-validates that contract with zod so a forged/garbled
 * response can never reach the view, and — defence in depth — zod's default strip drops
 * any unexpected key (a guest_id / token / contact could not leak through even if the
 * RPC regressed).
 *
 * Kept pure (no `server-only`, no DB, no React) so it unit-tests without a database and
 * is safely shared by the trusted server read and the client feed component.
 */

/**
 * One comment as it leaves get_comments / add_comment. Unknown keys are stripped by
 * zod's default, so author identifiers / contact never survive even if present upstream.
 */
const commentEntrySchema = z.object({
  id: z.string(),
  body: z.string(),
  author_display_name: z.string().nullable(),
  is_host: z.boolean(),
  created_at: z.string(),
});

export interface CommentEntry {
  id: string;
  body: string;
  /** Author's name (a guest's or the host's); null only if upstream had none. */
  author_display_name: string | null;
  /** True when the host authored it — surfaced as a badge, nothing linkable. */
  is_host: boolean;
  /** ISO timestamp; hidden by the view when hide_feed_timestamps is set (pure render). */
  created_at: string;
}

/**
 * Validate + shape the `get_comments` jsonb at the boundary. A non-array / garbled
 * payload collapses to [] (the feed degrades to "no comments yet" rather than crashing).
 * The RPC already returns 时间正序 (oldest→newest); we preserve that order.
 */
export function parseComments(payload: unknown): CommentEntry[] {
  const parsed = z.array(commentEntrySchema).safeParse(payload);
  if (!parsed.success) return [];
  return parsed.data.map((c) => ({
    id: c.id,
    body: c.body,
    author_display_name: c.author_display_name,
    is_host: c.is_host,
    created_at: c.created_at,
  }));
}

/** Validate a single inserted comment (the add_comment confirmation), or null. */
export function parseComment(payload: unknown): CommentEntry | null {
  const parsed = commentEntrySchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** Longest comment body we accept (UI fail-fast; the RPC is the real boundary). */
export const COMMENT_MAX_LENGTH = 2000;

/**
 * Posting contract for `add_comment`. Mirrors the RPC's accepted intent so the UI can
 * fail fast: a non-empty, bounded body, plus the guest's OWN event-scoped token
 * (recovered from localStorage). The token is optional — a logged-in host posts with
 * no token (auth binds the author). A client-chosen token can at most match an existing
 * event-scoped guest, never forge a new identity (the RPC re-checks it via the helper).
 */
export const commentInputSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Write something first.")
    .max(COMMENT_MAX_LENGTH, "That comment is a bit long."),
  token: z.uuid().nullish(),
});

export type CommentInput = z.infer<typeof commentInputSchema>;

const TIME_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: EVENT_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Display-only timestamp for a comment ("6月17日 15:42"); empty on a bad value. */
export function formatCommentTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return TIME_FMT.format(new Date(ms));
}
