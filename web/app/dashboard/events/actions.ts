"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { type EventInput, type PasswordChange, parseEventForm } from "@/lib/events/schema";
import { createClient } from "@/lib/supabase/server";

export type EventFormState = {
  status: "idle" | "success" | "error";
  message?: string;
};

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

  // UPDATE scoped by id; RLS USING (host_id = auth.uid()) means a non-owner
  // matches zero rows. We select() back so we can tell "saved" from "not yours".
  const { data: updated, error: updateError } = await supabase
    .from("events")
    .update({
      status: intent === "publish" ? "published" : "draft",
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
