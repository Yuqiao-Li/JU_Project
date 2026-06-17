import { useTranslations } from "next-intl";

import { AddToCalendar } from "@/components/events/add-to-calendar";
import { spotsLeftLabel } from "@/lib/events/capacity";
import { formatEventWhen } from "@/lib/events/format";
import { themeColorFromJson, themeSwatch } from "@/lib/events/theme";
import type { EventView } from "@/lib/events/view";

/**
 * Public event view (task 2.4a) — the shared, presentational render of an event's
 * tiered façade. Rendered (via the client `EventClient` shell) by the SSR `/{slug}`
 * page AND, after a correct password, by the client password gate. This component is
 * presentational only: it renders whatever tier the payload already carries and slots
 * in the RSVP interaction (`rsvpSlot`, task 2.4b) where the standing used to be.
 *
 * STRICT TIERING — the security-bearing part (DESIGN-TONE: "未 RSVP 真实地不渲染地址").
 * The full address (`location_text`) is rendered ONLY when the payload reports
 * `unlocked` AND actually carries it. When the viewer is locked the DATA LAYER never
 * returns it (get_event_by_slug omits second-tier fields), so there is nothing here to
 * hide with CSS — we show the city (first tier) and a prompt to RSVP for the exact
 * address. Counts render only when the RPC included them; hide_guest_count and the
 * private-unlocked rule omit the keys entirely (D7②), so a missing key reads as hidden.
 *
 * The host's accent color (events.theme.color) personalizes the hero — DESIGN-TONE's
 * one place to "spend the boldness": the poster.
 */
export function EventView({
  event,
  rsvpSlot,
  pollSlot,
  guestListSlot,
  commentsSlot,
}: {
  event: EventView;
  /** The RSVP interaction (client), slotted in by `EventClient`. */
  rsvpSlot?: React.ReactNode;
  /**
   * The date poll (client), slotted in by `EventClient` (task 5.1). Read-open (the
   * tally shows for any viewer), voting gated inside the slot (and in the DB). Renders
   * only while the date is still being decided — null once finalized / not a poll.
   */
  pollSlot?: React.ReactNode;
  /**
   * The "who's coming" list (client), slotted in by `EventClient` (task 3.1). It is
   * second-tier: it only renders for an unlocked viewer and only the data the RPC
   * already desensitized, so a locked view shows nothing here (the slot returns null).
   */
  guestListSlot?: React.ReactNode;
  /**
   * The Activity Feed (client), slotted in by `EventClient` (task 4.1). Unlike the
   * list it is READ-OPEN — it renders for locked and unlocked viewers alike — but
   * POSTING is gated inside the slot (and in the DB).
   */
  commentsSlot?: React.ReactNode;
}) {
  const t = useTranslations("eventPage");
  const accent = themeSwatch(themeColorFromJson(event.theme)).hex;
  const when = formatEventWhen(event.starts_at ?? null, event.date_tbd ?? false);
  const isPrivate = event.visibility === "private";

  // Address tier: only ever the full text when the payload says unlocked AND carries
  // it. Otherwise the city (first tier) is all there is to show.
  const fullAddress = event.unlocked ? event.location_text ?? null : null;
  const mapUrl = event.unlocked ? event.location_url ?? null : null;

  const hasCount = typeof event.going_count === "number";
  const remaining = event.capacity_remaining; // number | null | undefined
  // Single source for "还剩 X 位 / 已满—等待名单" (shared with the host stat, task 3.2).
  const capacityLine = spotsLeftLabel(remaining);

  return (
    <article className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-8 sm:py-14">
      {/* ── Hero / poster: the signature element ─────────────────────────────── */}
      <Hero event={event} accent={accent} when={when} isPrivate={isPrivate} />

      {/* ── Headcount (first tier, only when the RPC returned counts) ─────────── */}
      {(hasCount || capacityLine) && (
        <div className="mt-6 flex flex-wrap items-center gap-2.5">
          {hasCount && (
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3.5 py-1.5 text-sm text-paper">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: accent }}
              />
              {t.rich("going", {
                count: event.going_count ?? 0,
                strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
              })}
            </span>
          )}
          {capacityLine && (
            <span className="inline-flex items-center rounded-full border border-line bg-surface/60 px-3.5 py-1.5 text-sm text-muted">
              {capacityLine}
            </span>
          )}
        </div>
      )}

      {/* ── Add to calendar (first tier; no date ⇒ renders nothing) ───────────── */}
      <AddToCalendar event={event} />

      {/* ── Date poll (read-open tally; voting gated inside, task 5.1) ──────────
          Renders only while the date is being decided; null once the host finalizes. */}
      {pollSlot}

      {/* ── Where ────────────────────────────────────────────────────────────── */}
      <Section title={t("whereTitle")}>
        {fullAddress ? (
          <div className="space-y-1">
            <p className="text-paper">{fullAddress}</p>
            {mapUrl && (
              <a
                href={mapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-sm font-medium text-iris underline-offset-2 hover:underline"
              >
                {t("openMap")}
              </a>
            )}
          </div>
        ) : event.location_city ? (
          <div className="space-y-1">
            <p className="text-paper">{event.location_city}</p>
            {event.rsvp_enabled !== false && (
              <p className="text-sm text-muted">{t("rsvpToSeeAddress")}</p>
            )}
          </div>
        ) : (
          <p className="text-muted">{t("locationTba")}</p>
        )}
      </Section>

      {/* ── About ────────────────────────────────────────────────────────────── */}
      {event.description && (
        <Section title={t("aboutTitle")}>
          <p className="whitespace-pre-wrap leading-relaxed text-paper/90">{event.description}</p>
        </Section>
      )}

      {/* ── Chip in (display only — never an obligation, D: chip_in 纯展示) ────── */}
      {event.chip_in_url && (
        <Section title={t("chipInTitle")}>
          {event.chip_in_note && <p className="text-paper/90">{event.chip_in_note}</p>}
          <a
            href={event.chip_in_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex h-10 items-center justify-center rounded-lg border border-line px-4 text-sm font-medium text-paper transition hover:bg-surface-2"
          >
            {t("chipInButton")}
          </a>
        </Section>
      )}

      {/* ── RSVP ──────────────────────────────────────────────────────────────
          The RSVP form (name + status + optional +1/contact, guest_token, waitlist)
          slots in here from EventClient. It re-reads the event with the token on
          success to reveal the unlocked view above (task 2.4b). */}
      {rsvpSlot}

      {/* ── Who's coming (second tier; unlocked viewers only, task 3.1) ─────────
          Renders only once an RSVP has unlocked the view — the data layer doesn't
          return the list otherwise, so for a locked viewer this slot is null. */}
      {guestListSlot}

      {/* ── Activity feed (read-open; posting gated inside, task 4.1) ─────────── */}
      {commentsSlot}
    </article>
  );
}

/** Poster hero: cover image (or a themed gradient), with title/host/when/city. */
function Hero({
  event,
  accent,
  when,
  isPrivate,
}: {
  event: EventView;
  accent: string;
  when: string;
  isPrivate: boolean;
}) {
  const t = useTranslations("eventPage");
  const cover = event.cover_image_url ?? null;
  const surface = cover
    ? { backgroundImage: `url(${JSON.stringify(cover)})` }
    : {
        backgroundImage: `radial-gradient(120% 120% at 20% 0%, ${accent}66, transparent 60%), radial-gradient(120% 120% at 90% 20%, ${accent}33, transparent 55%)`,
      };

  return (
    <div
      className="relative flex min-h-[15rem] flex-col justify-end overflow-hidden rounded-3xl border border-line bg-surface bg-cover bg-center p-6 sm:min-h-[18rem] sm:p-8"
      style={surface}
    >
      {/* Scrim for legible text over any cover. */}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink via-ink/55 to-transparent" />
      <div className="relative">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {event.host_display_name && (
            <span>{t("hostedBy", { name: event.host_display_name })}</span>
          )}
          {isPrivate && (
            <span className="rounded-full border border-line bg-ink/50 px-2.5 py-0.5 text-xs text-muted backdrop-blur">
              {t("privateBadge")}
            </span>
          )}
        </div>
        <h1 className="mt-2 text-balance font-display text-3xl font-extrabold leading-tight text-paper sm:text-4xl">
          {event.title}
        </h1>
        <p className="mt-2 font-medium" style={{ color: accent }}>
          {when}
        </p>
        {event.location_city && <p className="mt-0.5 text-muted">{event.location_city}</p>}
      </div>
    </div>
  );
}

/** A titled content block with the app's eyebrow label. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="eyebrow">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}
