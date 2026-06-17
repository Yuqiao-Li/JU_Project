import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { createClient } from "@/lib/supabase/server";

import { EventForm } from "../event-form";

/**
 * Create event (task 2.2a). Server Component guard — re-check the session here,
 * never trust the proxy alone (same pattern as the dashboard). The form posts to
 * the createEvent Server Action, which mints the slug and inserts under the
 * host's own RLS path.
 */
export default async function NewEventPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard/events/new");

  const t = await getTranslations("eventForm");

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
      <Link href="/dashboard" className="text-sm text-muted transition hover:text-paper">
        ← {t("backToEvents")}
      </Link>
      <p className="eyebrow mt-6">{t("newEyebrow")}</p>
      <h1 className="mt-2 text-balance font-display text-3xl font-extrabold text-paper">
        {t("newHeading")}
      </h1>
      <p className="mt-3 text-muted">{t("newSubhead")}</p>

      <div className="mt-10">
        <EventForm mode="create" />
      </div>
    </div>
  );
}
