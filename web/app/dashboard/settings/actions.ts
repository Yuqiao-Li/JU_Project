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
  } else {
    // Clearing the username deletes the public /u/<handle> and 404s every shared
    // link, so it must be an explicit, confirmed choice — never a silent side
    // effect of an empty field. The client sends `confirm_clear` only after the
    // host confirms; without it (and only when they actually had a username) we
    // block the write and report it so the field state isn't lost (H19).
    const hadUsername = await supabase
      .from("profiles")
      .select("username")
      .eq("id", user.id)
      .maybeSingle();
    const previous = hadUsername.data?.username ?? null;
    const confirmed = String(formData.get("confirm_clear") ?? "") === "true";
    if (previous && !confirmed) {
      return { status: "error", message: "USERNAME_CLEAR_UNCONFIRMED" };
    }
  }

  // WeChat (round-4) — optional, managed here independently of event creation. Empty
  // clears it; bounded length, trimmed. Single source of truth = the profile.
  const rawWechat = String(formData.get("wechat_id") ?? "").trim();
  if (rawWechat.length > 100) {
    return { status: "error", message: "That WeChat ID is a bit long." };
  }
  const wechatId: string | null = rawWechat.length > 0 ? rawWechat : null;

  // UPDATE scoped to the caller's own row. id comes from auth.uid(), never the
  // client; RLS enforces it regardless.
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: displayName.data, username, wechat_id: wechatId })
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
