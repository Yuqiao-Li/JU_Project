import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { themeColorFromJson } from "@/lib/events/theme";
import { createClient } from "@/lib/supabase/server";

import { EventForm, type EventDefaults } from "../../event-form";

/**
 * Edit event (task 2.2a). Server Component guard + load the event via the host's
 * own RLS path: USING (host_id = auth.uid()) means a non-owner simply gets no
 * row → notFound(). The stored password hash never leaves the server; we pass
 * only a `hasPassword` boolean to the form.
 */
export default async function EditEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { id } = await params;
  const { created } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/dashboard/events/${id}/edit`);

  const { data: event } = await supabase
    .from("events")
    .select(
      "id, slug, title, description, date_tbd, starts_at, ends_at, location_text, location_url, location_city, visibility, capacity, allow_plus_ones, max_plus_ones, rsvp_enabled, status, view_password_hash, cover_image_url, theme, effect, chip_in_url, chip_in_note",
    )
    .eq("id", id)
    .maybeSingle();

  if (!event) notFound();

  const defaults: EventDefaults = {
    id: event.id,
    title: event.title,
    description: event.description ?? "",
    dateTbd: event.date_tbd,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    locationText: event.location_text ?? "",
    locationUrl: event.location_url ?? "",
    locationCity: event.location_city ?? "",
    visibility: event.visibility === "private" ? "private" : "public",
    capacity: event.capacity,
    allowPlusOnes: event.allow_plus_ones,
    maxPlusOnes: event.max_plus_ones,
    rsvpEnabled: event.rsvp_enabled,
    status: event.status,
    hasPassword: event.view_password_hash !== null,
    coverImageUrl: event.cover_image_url ?? "",
    themeColor: themeColorFromJson(event.theme),
    effect: event.effect ?? "none",
    chipInUrl: event.chip_in_url ?? "",
    chipInNote: event.chip_in_note ?? "",
  };

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8">
      <Link href="/dashboard" className="text-sm text-muted transition hover:text-paper">
        ← Your events
      </Link>

      <div className="mt-6 flex items-center gap-3">
        <p className="eyebrow">Edit event</p>
        <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
          {event.status === "published" ? "Published" : event.status === "cancelled" ? "Cancelled" : "Draft"}
        </span>
      </div>
      <h1 className="mt-2 text-balance font-display text-3xl font-extrabold text-paper">{event.title}</h1>

      {created && (
        <p className="mt-4 rounded-xl border border-iris/40 bg-iris/10 px-4 py-3 text-sm text-paper">
          Your event is live. Share this link — guests RSVP without an account.
        </p>
      )}

      <div className="mt-4 rounded-xl border border-line bg-surface/60 px-4 py-3">
        <p className="text-sm text-muted">Public link</p>
        <code className="mt-1 block break-all font-mono text-sm text-iris">/{event.slug}</code>
      </div>

      <div className="mt-10">
        <EventForm mode="edit" defaults={defaults} />
      </div>
    </div>
  );
}
