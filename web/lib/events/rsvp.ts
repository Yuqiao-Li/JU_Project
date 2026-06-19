import { z } from "zod";

/**
 * RSVP input/output contracts for `submit_rsvp` (task 2.4b).
 *
 * Shared by the client RSVP form (early, friendly client-side validation) and the
 * trusted submit Route Handler (re-validation at the boundary). NO `server-only`
 * here — only zod schemas + plain types ever cross to the client, never a trusted
 * module. The DB function (0008) is the real trust boundary: it re-validates every
 * input, mints/keeps the guest_token SERVER-SIDE, decides going-vs-waitlisted under
 * an advisory lock, links guests.user_id from auth.uid(), and enforces the write-side
 * rate limit. This schema only mirrors its ACCEPTED INTENT so the UI can fail fast.
 */

/**
 * A guest's REQUESTED status. 'waitlisted' is a SERVER outcome (capacity full), never
 * a client request — mirrors submit_rsvp, which rejects anything else as an intent.
 */
export const RSVP_STATUSES = ["going", "maybe", "not_going"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const rsvpInputSchema = z.object({
  // The only required field — RSVP needs no account, just a name.
  display_name: z.string().trim().min(1, "Add your name.").max(80, "That name is a bit long."),
  status: z.enum(RSVP_STATUSES),
  // Clamped again server-side against allow_plus_ones / max_plus_ones; bounded here
  // so a forged body can't send absurd numbers. Absent → 0.
  plus_ones: z.number().int().min(0).max(20).default(0),
  // contact is host-visible metadata ONLY and NEVER an identity/auth key (D1). Optional.
  contact: z.string().trim().max(200).nullish(),
  // Round-4: guest WeChat. The DB enforces it as REQUIRED for going/maybe (and gates
  // its later reveal on lock); this boundary mirror only bounds the length so a forged
  // body can't send an absurd value. Optional here — the form gates required-ness.
  wechat_id: z.string().trim().max(100).nullish(),
  // The returning guest's OWN credential, recovered from localStorage. Optional; when
  // absent the server mints a fresh token. UUID-shaped or omitted — a client-chosen
  // value can at most match an existing event-scoped guest, never forge a new identity.
  guest_token: z.uuid().nullish(),
});

export type RsvpInput = z.infer<typeof rsvpInputSchema>;

/**
 * The confirmed outcome `submit_rsvp` returns (D15). `guest_token` is the token of the
 * row actually written (fresh for a new guest, the existing one on an edit) — the
 * client stores it in localStorage to edit later. `status` is the CONFIRMED status,
 * which may be 'waitlisted' even when 'going' was requested. No third-tier field
 * (other guests' tokens/contact, the list) is ever present.
 */
export const rsvpResultSchema = z.object({
  event_id: z.string(),
  guest_id: z.string(),
  guest_token: z.string(),
  status: z.string(),
  plus_ones: z.number(),
  waitlisted: z.boolean(),
});

export type RsvpResult = z.infer<typeof rsvpResultSchema>;
