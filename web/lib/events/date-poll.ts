import { z } from "zod";

/**
 * Date-poll contracts for `get_date_poll` / `vote_dates` (task 5.1).
 *
 * Shared (no `server-only`) by the trusted server read (`read-date-poll.ts`), the
 * poll/vote Route Handlers, and the client components that render the poll. Importing
 * these TYPES/schemas into the client never pulls a trusted module along.
 *
 * The DB functions remain the trust boundary: `get_date_poll` enforces the private
 * gate (D3) and resolves the caller's own selection through the shared unlock gate;
 * `vote_dates` re-checks that gate and is the only write path. This schema only mirrors
 * the shape so the UI can render it and fail fast — and strips anything off-contract.
 */

/** One candidate date with its live tally. */
export const datePollOptionSchema = z.object({
  id: z.string(),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  votes: z.number(),
});
export type DatePollOption = z.infer<typeof datePollOptionSchema>;

/** The full poll payload `get_date_poll` returns. */
export const datePollSchema = z.object({
  event_id: z.string(),
  date_tbd: z.boolean(),
  finalized: z.boolean(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  unlocked: z.boolean(),
  options: z.array(datePollOptionSchema).default([]),
  my_option_ids: z.array(z.string()).default([]),
});
export type DatePoll = z.infer<typeof datePollSchema>;

/** Parse an unknown payload into a DatePoll, or null when it isn't one. */
export function parseDatePoll(data: unknown): DatePoll | null {
  const parsed = datePollSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * A guest's vote submission. `option_ids` is the COMPLETE new selection (vote_dates is
 * a replacing multi-select upsert — de-selected options are dropped). The token is the
 * guest's own credential from localStorage; it travels only in the POST body the app
 * builds, never a shareable URL.
 */
export const voteInputSchema = z.object({
  token: z.uuid("Reply to the event before voting on a date."),
  option_ids: z.array(z.uuid()).max(50).default([]),
});
export type VoteInput = z.infer<typeof voteInputSchema>;

/** True when the public page should show the poll: dates are still being decided and
 *  there are candidates to vote on. After the host finalizes (date_tbd cleared) the
 *  chosen date replaces the poll. */
export function pollIsActive(poll: DatePoll | null | undefined): poll is DatePoll {
  return !!poll && poll.date_tbd && !poll.finalized && poll.options.length > 0;
}
