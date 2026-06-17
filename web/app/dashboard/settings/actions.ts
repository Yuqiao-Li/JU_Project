"use server";

import { revalidatePath } from "next/cache";

import { displayNameSchema, usernameSchema } from "@/lib/profile/username";
import { createClient } from "@/lib/supabase/server";

export type ProfileFormState = {
  status: "idle" | "success" | "error";
  message?: string;
};

/**
 * Update the signed-in host's profile (display name + public username).
 *
 * Hard rules (CLAUDE.md / TASKS 2.1):
 *  - The client NEVER sends profiles.id. We scope the UPDATE to `auth.uid()`
 *    server-side; RLS (id = auth.uid()) is the real guard. No upsert/insert —
 *    the row already exists from the auth.users trigger.
 *  - Username uniqueness is the DB index's job. The advisory UI check is only a
 *    hint; the authoritative answer is this write's unique-violation (23505),
 *    which we surface as a friendly message.
 */
export async function updateProfile(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "error", message: "Your session expired. Sign in again." };

  // zod at the boundary.
  const displayName = displayNameSchema.safeParse(formData.get("display_name") ?? "");
  if (!displayName.success) {
    return { status: "error", message: displayName.error.issues[0]?.message ?? "Check your name." };
  }

  const rawUsername = String(formData.get("username") ?? "").trim();
  let username: string | null = null;
  if (rawUsername.length > 0) {
    const parsed = usernameSchema.safeParse(rawUsername);
    if (!parsed.success) {
      return { status: "error", message: parsed.error.issues[0]?.message ?? "Check your username." };
    }
    username = parsed.data;
  }

  // UPDATE scoped to the caller's own row. id comes from auth.uid(), never the
  // client; RLS enforces it regardless.
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: displayName.data, username })
    .eq("id", user.id);

  if (error) {
    if (error.code === "23505") {
      return { status: "error", message: "That username is taken. Try another." };
    }
    return { status: "error", message: "Couldn't save your profile. Try again." };
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  return { status: "success", message: "Saved." };
}
