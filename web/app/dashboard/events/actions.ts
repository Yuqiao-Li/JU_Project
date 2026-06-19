"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { type EventInput, type PasswordChange, parseEventForm } from "@/lib/events/schema";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";

export type EventFormState = {
  status: "idle" | "success" | "error";
  message?: string;
};

/**
 * Read + validate the host's WeChat from the event form (round-4). WeChat is the
 * host's own profile field (single source of truth — NOT an events column), prefilled
 * into the form and required at create/save so the lock-time two-way reveal has a value
 * to surface. Returns the trimmed value, or an error sentinel the action surfaces.
 */
function readHostWechat(formData: FormData): { ok: true; value: string } | { ok: false } {
  const raw = String(formData.get("wechat_id") ?? "").trim();
  if (raw.length === 0 || raw.length > 100) return { ok: false };
  return { ok: true, value: raw };
}

/**
 * Create / edit event server actions (task 2.2a, core fields).
 *
 * Authorization is the DB's job, never the form's (CLAUDE.md): every write runs
 * through the host's own authenticated client, so RLS (host_id = auth.uid()) and
 * the host-only set_event_password RPC are the real guards. We still re-check the
 * session here because Server Actions are reachable by direct POST.
 */

/** Map normalised form input → the events row columns. 🟡 columns stay default. */
function toEventColumns(input: EventInput) {
  return {
    title: input.title,
    description: input.description,
    date_tbd: input.date_tbd,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    location_text: input.location_text,
    location_url: input.location_url,
    location_city: input.location_city,
    visibility: input.visibility,
    capacity: input.capacity,
    allow_plus_ones: input.allow_plus_ones,
    max_plus_ones: input.max_plus_ones,
    rsvp_enabled: input.rsvp_enabled,
    // Task 2.2b — look + chip-in. theme is a small jsonb { color }.
    cover_image_url: input.cover_image_url,
    theme: input.theme as Json,
    effect: input.effect,
    chip_in_url: input.chip_in_url,
    chip_in_note: input.chip_in_note,
  };
}

export async function createEvent(_prev: EventFormState, formData: FormData): Promise<EventFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "Your session expired. Sign in again." };

  const parsed = parseEventForm(formData);
  if (!parsed.ok) return { status: "error", message: parsed.message };
  const { input, intent, password } = parsed.value;

  // Host WeChat (round-4) — required, stored on the host's own profile (single source
  // of truth). Validate BEFORE creating so we don't leave a wechat-less event behind.
  const wechat = readHostWechat(formData);
  if (!wechat.ok) {
    return { status: "error", message: "Add your WeChat so guests can reach you once the event locks." };
  }

  // Mint the human-readable + crypto-tailed slug (D15). The DB column also has a
  // crypto-strong fallback default, but the readable slug comes from here.
  const { data: slug, error: slugError } = await supabase.rpc("generate_event_slug", {
    title: input.title,
  });
  if (slugError || !slug) {
    return { status: "error", message: "Couldn't create the event link. Try again." };
  }

  // INSERT via the host's own client: RLS WITH CHECK (host_id = auth.uid())
  // enforces ownership; the AFTER INSERT trigger writes the event_hosts owner row.
  const { data: created, error: insertError } = await supabase
    .from("events")
    .insert({
      host_id: user.id,
      slug,
      status: intent === "publish" ? "published" : "draft",
      ...toEventColumns(input),
    })
    .select("id")
    .single();

  if (insertError || !created) {
    return { status: "error", message: "Couldn't create your event. Try again." };
  }

  // Password is hashed server-side in the DB (set_event_password). Only "set" can
  // happen on create — there's nothing to clear yet.
  if (password.action === "set") {
    const passwordError = await applyPassword(supabase, created.id, password);
    if (passwordError) return { status: "error", message: passwordError };
  }

  // WeChat lives only on the profile (RLS: own row, id = auth.uid()).
  await supabase.from("profiles").update({ wechat_id: wechat.value }).eq("id", user.id);

  revalidatePath("/dashboard");
  // Land on the event's own page so the host can grab the public link.
  redirect(`/dashboard/events/${created.id}/edit?created=1`);
}

export async function updateEvent(_prev: EventFormState, formData: FormData): Promise<EventFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "Your session expired. Sign in again." };

  const eventId = String(formData.get("event_id") ?? "");
  if (!eventId) return { status: "error", message: "Couldn't tell which event to save." };

  const parsed = parseEventForm(formData);
  if (!parsed.ok) return { status: "error", message: parsed.message };
  const { input, intent, password } = parsed.value;

  // Host WeChat (round-4) — required, saved to the host's own profile.
  const wechat = readHostWechat(formData);
  if (!wechat.ok) {
    return { status: "error", message: "Add your WeChat so guests can reach you once the event locks." };
  }

  // Don't let a content Save resurrect a cancelled event (H5): a cancelled event
  // keeps its status until the host explicitly re-publishes via setEventStatus.
  // For draft/published events the publish/draft toggle still applies.
  const { data: existing } = await supabase
    .from("events")
    .select("status")
    .eq("id", eventId)
    .maybeSingle();
  const nextStatus =
    existing?.status === "cancelled" ? "cancelled" : intent === "publish" ? "published" : "draft";

  // UPDATE scoped by id; RLS USING (host_id = auth.uid()) means a non-owner
  // matches zero rows. We select() back so we can tell "saved" from "not yours".
  const { data: updated, error: updateError } = await supabase
    .from("events")
    .update({
      status: nextStatus,
      ...toEventColumns(input),
    })
    .eq("id", eventId)
    .select("id")
    .maybeSingle();

  if (updateError) return { status: "error", message: "Couldn't save your changes. Try again." };
  if (!updated) return { status: "error", message: "We couldn't find that event under your account." };

  if (password.action !== "keep") {
    const passwordError = await applyPassword(supabase, eventId, password);
    if (passwordError) return { status: "error", message: passwordError };
  }

  // WeChat lives only on the profile (RLS: own row, id = auth.uid()).
  await supabase.from("profiles").update({ wechat_id: wechat.value }).eq("id", user.id);

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/events/${eventId}/edit`);
  return { status: "success", message: "Saved." };
}

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/** Set or clear the bcrypt password via the host-only DB RPC. Returns a message on failure. */
async function applyPassword(
  supabase: ServerClient,
  eventId: string,
  password: PasswordChange,
): Promise<string | null> {
  const { error } = await supabase.rpc("set_event_password", {
    event_id: eventId,
    password: password.action === "clear" ? "" : password.value,
  });
  if (error) return "Saved the details, but couldn't update the password. Try again.";
  return null;
}

export type LifecycleState = { ok: boolean; error?: string };

const LIFECYCLE_STATUSES = ["draft", "published", "cancelled"] as const;
type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/**
 * Host-only lifecycle status change (publish / unpublish→draft / cancel / republish).
 * Authorization is RLS: the UPDATE is scoped by id and USING (host_id = auth.uid()),
 * so a non-owner matches zero rows. Returns a stable error CODE; the caller renders
 * the localized message.
 */
export async function setEventStatus(
  eventId: string,
  status: LifecycleStatus,
): Promise<LifecycleState> {
  if (!LIFECYCLE_STATUSES.includes(status)) return { ok: false, error: "bad_status" };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  const { data, error } = await supabase
    .from("events")
    .update({ status })
    .eq("id", eventId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "failed" };
  if (!data) return { ok: false, error: "not_found" };

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/events/${eventId}`);
  return { ok: true };
}

/**
 * Host-only event lock (round-4) — irreversible finalize via the DEFINER RPC
 * lock_event. The RPC re-checks host ownership (auth.uid() == host_id) and only ever
 * moves locked_at null → now() (idempotent, never cleared). Locking closes new RSVPs
 * and opens the two-way WeChat reveal. Returns a stable error code; the caller renders
 * the localized message.
 */
export async function lockEvent(eventId: string): Promise<LifecycleState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  const { error } = await supabase.rpc("lock_event", { event_id: eventId });
  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("not authorized") || msg.includes("not found")) {
      return { ok: false, error: "not_found" };
    }
    return { ok: false, error: "failed" };
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/events/${eventId}`);
  return { ok: true };
}

/**
 * Host-only hard delete. RLS DELETE USING (host_id = auth.uid()) is the guard;
 * guests/rsvps/comments cascade via ON DELETE CASCADE. Redirects to the dashboard.
 */
export async function deleteEvent(eventId: string): Promise<LifecycleState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  const { error, count } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .eq("id", eventId);

  if (error) return { ok: false, error: "failed" };
  if (!count) return { ok: false, error: "not_found" };

  revalidatePath("/dashboard");
  redirect("/dashboard");
}
