"use server";

import { revalidatePath } from "next/cache";

import { displayNameSchema } from "@/lib/profile/username";
import { createClient } from "@/lib/supabase/server";

export type ProfileFormState = {
  status: "idle" | "success" | "error";
  message?: string;
};

/**
 * Update the signed-in host's profile (nickname + contacts).
 *
 * Step-10A task 7: the public-username handle is retired (入口是局不是人, §5).
 * The single name field IS the nickname (display_name); the profiles.username
 * column is KEPT in the DB (existing values untouched) but no longer surfaced
 * or edited here. WeChat + general contact are host-owned and revealed to guests
 * only after the event finalizes (double-blind, via get_event_by_slug).
 *
 * Hard rules (CLAUDE.md / TASKS 2.1):
 *  - The client NEVER sends profiles.id. We scope the UPDATE to `auth.uid()`
 *    server-side; RLS (id = auth.uid()) is the real guard. No upsert/insert —
 *    the row already exists from the auth.users trigger.
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

  // WeChat (round-4) — optional, managed here independently of event creation. Empty
  // clears it; bounded length, trimmed. Single source of truth = the profile.
  const rawWechat = String(formData.get("wechat_id") ?? "").trim();
  if (rawWechat.length > 100) {
    return { status: "error", message: "That WeChat ID is a bit long." };
  }
  const wechatId: string | null = rawWechat.length > 0 ? rawWechat : null;

  // General contact (Step-10A) — optional, host-owned. Mirrors wechat_id: empty clears
  // it, bounded + trimmed. Guest-facing reveal is double-blind (only after the event
  // finalizes, through get_event_by_slug) — nothing identity/auth-bearing here.
  const rawContact = String(formData.get("contact") ?? "").trim();
  if (rawContact.length > 200) {
    return { status: "error", message: "That contact is a bit long." };
  }
  const contact: string | null = rawContact.length > 0 ? rawContact : null;

  // UPDATE scoped to the caller's own row. id comes from auth.uid(), never the
  // client; RLS enforces it regardless. username is intentionally NOT written here —
  // the column is kept but no longer edited (Step-10A task 7).
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: displayName.data, wechat_id: wechatId, contact })
    .eq("id", user.id);

  if (error) {
    return { status: "error", message: "Couldn't save your profile. Try again." };
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  return { status: "success", message: "Saved." };
}
