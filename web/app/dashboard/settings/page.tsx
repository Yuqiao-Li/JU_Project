import Link from "next/link";
import { redirect } from "next/navigation";

import { Wordmark } from "@/components/brand/wordmark";
import { createClient } from "@/lib/supabase/server";

import { ProfileForm } from "./profile-form";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard/settings");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, username")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
        <Wordmark href="/dashboard" />
        <Link href="/dashboard" className="text-sm text-muted transition hover:text-paper">
          Back to events
        </Link>
      </header>

      <main className="mx-auto w-full max-w-md flex-1 px-5 py-12 sm:px-8">
        <p className="eyebrow">Profile</p>
        <h1 className="mt-2 font-display text-2xl font-extrabold text-paper">Your details</h1>
        <p className="mt-2 text-sm text-muted">
          Your name shows on events you host. Your username is your public profile at{" "}
          <span className="font-mono text-paper">/u/&lt;username&gt;</span>.
        </p>

        <div className="mt-8">
          <ProfileForm
            initialDisplayName={profile?.display_name ?? ""}
            initialUsername={profile?.username ?? ""}
          />
        </div>
      </main>
    </div>
  );
}
