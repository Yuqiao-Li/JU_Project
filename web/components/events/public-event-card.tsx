import Link from "next/link";

import { LocalWhen } from "@/components/events/local-when";
import type { PublicEvent } from "@/lib/events/public-events";

/**
 * A single PUBLIC event card, shared by the Organizer Profile (/u/[username])
 * and the site-wide discovery page (/discover) so the two never diverge. It
 * renders ONLY first-tier façade fields (title, city, when, cover, optional host
 * display name) — never address, guest list, or contact — and links to the
 * event's public page at `/{slug}`.
 *
 * `hostedByLabel`, when given, shows who is hosting (discovery needs it; the
 * per-host profile already has the host in its header, so it omits it).
 */
export function PublicEventCard({
  event,
  dateTbdLabel,
  muted = false,
  hostedByLabel,
}: {
  event: PublicEvent;
  dateTbdLabel: string;
  muted?: boolean;
  /** Pre-formatted "由 X 发起" line, or omit to hide the host line. */
  hostedByLabel?: string;
}) {
  const whenIso = event.date_tbd ? null : event.starts_at;
  return (
    <Link
      href={`/${event.slug}`}
      className={`group block overflow-hidden rounded-2xl border border-line bg-surface/60 transition hover:border-iris/50 hover:bg-surface ${
        muted ? "opacity-80" : ""
      }`}
    >
      <div
        className="aspect-[16/9] w-full bg-surface-2 bg-cover bg-center"
        style={
          event.cover_image_url
            ? { backgroundImage: `url(${JSON.stringify(event.cover_image_url)})` }
            : undefined
        }
      >
        {!event.cover_image_url && (
          <div className="h-full w-full bg-gradient-to-br from-iris/25 via-surface-2 to-coral/20" />
        )}
      </div>
      <div className="p-5">
        <h3 className="font-display text-lg font-bold text-paper">{event.title}</h3>
        {hostedByLabel && <p className="mt-0.5 text-xs text-muted">{hostedByLabel}</p>}
        <p className="mt-1 text-sm text-muted">
          <LocalWhen iso={whenIso} tbdLabel={dateTbdLabel} />
          {event.location_city ? ` · ${event.location_city}` : ""}
        </p>
      </div>
    </Link>
  );
}
