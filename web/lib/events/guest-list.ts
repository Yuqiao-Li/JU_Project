import { z } from "zod";

/**
 * The desensitized guest list (task 3.1) — the boundary + shaping for the
 * `get_guest_list` RPC payload.
 *
 * THE LIST IS SECOND-TIER AND DESENSITIZED (SCHEMA "get_guest_list" / D15;
 * TEST-SPEC §3.1). The RPC already enforces the hard rules in the database — it is
 * unlock-gated, returns ONLY Going/Maybe (never Can't-Go or Waitlisted), and exposes
 * ONLY display_name/status/plus_ones (never guest_id, guest_token or contact). This
 * module is the front-end's matching boundary: it re-validates that contract with zod
 * so a forged/garbled response can never reach the view, and — defence in depth —
 *   • zod's default strip drops any unexpected key (contact / guest_id / token), so a
 *     third-tier field can't leak through even if the RPC regressed, and
 *   • parseGuestList itself DISCARDS any entry whose status isn't going/maybe, so a
 *     Can't-Go/Waitlisted row could never be rendered to a guest.
 *
 * Kept pure (no `server-only`, no DB, no React) so it unit-tests without a database and
 * is safely shared by the trusted server read and the client list component.
 */

/** The only statuses ever surfaced on the public list — Going/Maybe. */
export const GUEST_LIST_STATUSES = ["going", "maybe"] as const;
export type GuestListStatus = (typeof GUEST_LIST_STATUSES)[number];

/**
 * One entry as it leaves the RPC. `status` is a loose string here so an out-of-contract
 * value is dropped by parseGuestList rather than throwing; unknown keys are stripped by
 * zod's default, so contact/guest_id/token never survive even if present upstream.
 */
const guestEntrySchema = z.object({
  display_name: z.string(),
  status: z.string(),
  plus_ones: z.number(),
});

export interface GuestListEntry {
  display_name: string;
  status: GuestListStatus;
  /** Additional heads this guest is bringing; always a non-negative integer. */
  plus_ones: number;
}

/**
 * Validate + shape the `get_guest_list` jsonb at the boundary. A non-array / garbled
 * payload collapses to [] (the list degrades to "nobody yet" rather than crashing).
 * Each surviving entry is forced to the going/maybe contract; anything else — including
 * a stray Can't-Go/Waitlisted row — is discarded so it can never be rendered.
 */
export function parseGuestList(payload: unknown): GuestListEntry[] {
  const parsed = z.array(guestEntrySchema).safeParse(payload);
  if (!parsed.success) return [];

  const out: GuestListEntry[] = [];
  for (const e of parsed.data) {
    if (!(GUEST_LIST_STATUSES as readonly string[]).includes(e.status)) continue;
    out.push({
      display_name: e.display_name,
      status: e.status as GuestListStatus,
      plus_ones: Number.isFinite(e.plus_ones) && e.plus_ones > 0 ? Math.floor(e.plus_ones) : 0,
    });
  }
  return out;
}

export interface GroupedGuestList {
  going: GuestListEntry[];
  maybe: GuestListEntry[];
}

/** Split the (already validated) list into its Going / Maybe groups, order preserved. */
export function groupGuestList(entries: GuestListEntry[]): GroupedGuestList {
  const going: GuestListEntry[] = [];
  const maybe: GuestListEntry[] = [];
  for (const e of entries) {
    if (e.status === "going") going.push(e);
    else maybe.push(e);
  }
  return { going, maybe };
}

/** Headcount of a group INCLUDING +1s (matches going_count's accounting, D7①). */
export function guestHeadcount(entries: GuestListEntry[]): number {
  return entries.reduce((sum, e) => sum + 1 + e.plus_ones, 0);
}
