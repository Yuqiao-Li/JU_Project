import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Wordmark } from "@/components/brand/wordmark";
import { createClient } from "@/lib/supabase/server";

import { ProfileForm } from "./profile-form";

export default async function SettingsPage() {
  const t = await getTranslations("settings");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard/settings");

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("display_name, wechat_id, contact")
    .eq("id", user.id)
    .maybeSingle();
  // A fetch error must not collapse into blank defaults — that would render the
  // form pre-filled as empty and risk a save wiping the real values. Throw so the
  // route error boundary (app/error.tsx) shows an error + retry instead (H20).
  if (error) {
    console.error("[settings] profile load failed:", error.message);
    throw new Error("Failed to load your profile");
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-8">
        <Wordmark href="/dashboard" />
        <Link href="/dashboard" className="text-sm text-muted transition hover:text-paper">
          {t("backToEvents")}
        </Link>
      </header>

      <main className="mx-auto w-full max-w-md flex-1 px-5 py-12 sm:px-8">
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1 className="mt-2 font-display text-2xl font-extrabold text-paper">{t("title")}</h1>
        <p className="mt-2 text-sm text-muted">{t("description")}</p>

        <div className="mt-8">
          <ProfileForm
            initialDisplayName={profile?.display_name ?? ""}
            initialWechatId={profile?.wechat_id ?? ""}
            initialContact={profile?.contact ?? ""}
          />
        </div>
      </main>
    </div>
  );
}
