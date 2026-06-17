"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

/**
 * Host promote action (task 3.2) — move a waitlisted guest to going.
 *
 * Authorization is the DATABASE's job, never this action: promote_guest is host-only at
 * the DB layer (it raises unless auth.uid() = events.host_id, D7③) and respects capacity
 * under the same per-event lock submit_rsvp uses, so it can never oversell the last seat.
 * We therefore run it through the HOST's OWN authed client (never the trusted role, which
 * would bypass that gate) and merely forward the call. The session re-check here is belt
 * and braces — server actions are reachable by direct POST.
 */

export type PromoteState = { status: "idle" | "success" | "error"; message?: string };

export async function promoteGuest(_prev: PromoteState, formData: FormData): Promise<PromoteState> {
  const rsvpId = String(formData.get("rsvp_id") ?? "");
  const eventId = String(formData.get("event_id") ?? "");
  if (!rsvpId || !eventId) return { status: "error", message: "Couldn't tell which guest to move." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "Your session expired. Sign in again." };

  const { error } = await supabase.rpc("promote_guest", { rsvp_id: rsvpId });
  if (error) {
    // The DB refuses a promote that would exceed capacity — surface that plainly.
    const message = /capacit/i.test(error.message ?? "")
      ? "No room left — free up a spot first."
      : "Couldn't move that guest. Try again.";
    return { status: "error", message };
  }

  revalidatePath(`/dashboard/events/${eventId}`);
  return { status: "success", message: "Moved to going." };
}
