import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { cloneEventDefaults } from "@/lib/events/clone";
import { type EventDefaults } from "@/app/dashboard/events/event-form";
import { createClient } from "@/lib/supabase/server";

import { EventForm } from "../event-form";

/** Columns the 一键复用 clone reads — mirrors CloneSourceRow in lib/events/clone.ts. */
const CLONE_SOURCE_COLUMNS =
  "title, description, date_tbd, starts_at, ends_at, location_text, location_url, location_city, visibility, capacity, allow_plus_ones, max_plus_ones, rsvp_enabled, cover_image_url, theme, effect, chip_in_url, chip_in_note, category, card_variant";

/**
 * Create event (task 2.2a). Server Component guard — re-check the session here,
 * never trust the proxy alone (same pattern as the dashboard). The form posts to
 * the createEvent Server Action, which mints the slug and inserts under the
 * host's own RLS path.
 *
 * 一键复用 (Step-10A, dashboard.md): with `?from=<id>` we read THAT event over the
 * host's own RLS path (USING host_id = auth.uid() → a non-owner matches no row, so a
 * forged id silently falls back to a blank create form) and prefill the form via the
 * pure cloneEventDefaults helper. No DB write happens here — the host edits the
 * bumped-forward time + details and submits createEvent to mint a brand-new event.
 */
export default async function NewEventPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard/events/new");

  // Prefill the host's WeChat from their profile (single source of truth, round-4).
  const { data: profile } = await supabase
    .from("profiles")
    .select("wechat_id")
    .eq("id", user.id)
    .maybeSingle();

  // 一键复用: pull the source event over the host's own client; RLS scopes it to their
  // own events, so a foreign/unknown id just yields no row → blank create form.
  let clonedDefaults: EventDefaults | undefined;
  if (from) {
    const { data: source } = await supabase
      .from("events")
      .select(CLONE_SOURCE_COLUMNS)
      .eq("id", from)
      .maybeSingle();
    if (source) {
      clonedDefaults = { ...cloneEventDefaults(source), wechatId: profile?.wechat_id ?? "" };
    }
  }

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
        {clonedDefaults ? (
          <EventForm mode="create" defaults={clonedDefaults} />
        ) : (
          <EventForm mode="create" hostWechatId={profile?.wechat_id ?? ""} />
        )}
      </div>
    </div>
  );
}
