"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/** Sign the host out and send them back to the front door. */
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
