"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

/**
 * Host date-poll actions (task 5.1) — add / remove a candidate date, and finalize one.
 *
 * Authorization is the DATABASE's job, never these actions: add_date_option /
 * remove_date_option / finalize_date are all HOST-ONLY at the DB layer (they raise
 * unless auth.uid() = events.host_id, D7③). We run them through the HOST's OWN authed
 * client (never the trusted role, which would bypass that gate) and merely forward the
 * call. The session re-check is belt-and-braces — server actions are reachable by direct
 * POST. Candidate dates are written with the same datetime-local-string handling the
 * event's own start time uses (parseEventForm), so the poll stays consistent with it.
 */

export type DatePollState = { status: "idle" | "success" | "error"; message?: string };

/** Datetime-local string ("2030-01-01T18:00"); empty → null; must be parseable. */
function parseDateTime(raw: string): string | null | { error: string } {
  const v = raw.trim();
  if (v === "") return null;
  if (Number.isNaN(Date.parse(v))) return { error: "That date and time doesn't look valid." };
  return v;
}

export async function addDateOption(_prev: DatePollState, formData: FormData): Promise<DatePollState> {
  const eventId = String(formData.get("event_id") ?? "");
  if (!eventId) return { status: "error", message: "Couldn't tell which event to add a date to." };

  const starts = parseDateTime(String(formData.get("starts_at") ?? ""));
  if (starts && typeof starts === "object") return { status: "error", message: starts.error };
  if (!starts) return { status: "error", message: "Pick a start time for this date." };

  const ends = parseDateTime(String(formData.get("ends_at") ?? ""));
  if (ends && typeof ends === "object") return { status: "error", message: ends.error };
  if (ends && Date.parse(ends) < Date.parse(starts)) {
    return { status: "error", message: "The end time can't be before the start time." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "Your session expired. Sign in again." };

  const { error } = await supabase.rpc("add_date_option", {
    event_id: eventId,
    starts_at: starts,
    ends_at: ends ?? undefined,
  });
  if (error) return { status: "error", message: "Couldn't add that date. Try again." };

  revalidatePath(`/dashboard/events/${eventId}/edit`);
  return { status: "success", message: "Date added." };
}

export async function removeDateOption(_prev: DatePollState, formData: FormData): Promise<DatePollState> {
  const optionId = String(formData.get("option_id") ?? "");
  const eventId = String(formData.get("event_id") ?? "");
  if (!optionId || !eventId) return { status: "error", message: "Couldn't tell which date to remove." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "Your session expired. Sign in again." };

  const { error } = await supabase.rpc("remove_date_option", { option_id: optionId });
  if (error) return { status: "error", message: "Couldn't remove that date. Try again." };

  revalidatePath(`/dashboard/events/${eventId}/edit`);
  return { status: "success", message: "Date removed." };
}

export async function finalizeDate(_prev: DatePollState, formData: FormData): Promise<DatePollState> {
  const optionId = String(formData.get("option_id") ?? "");
  const eventId = String(formData.get("event_id") ?? "");
  if (!optionId || !eventId) return { status: "error", message: "Couldn't tell which date to lock in." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "Your session expired. Sign in again." };

  const { error } = await supabase.rpc("finalize_date", { event_id: eventId, option_id: optionId });
  if (error) return { status: "error", message: "Couldn't lock in that date. Try again." };

  // The chosen date now lives on the event; refresh the dashboard + public-facing reads.
  revalidatePath(`/dashboard/events/${eventId}/edit`);
  revalidatePath(`/dashboard/events/${eventId}`);
  revalidatePath("/dashboard");
  return { status: "success", message: "Date locked in." };
}
