import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { EventClient } from "./event-client";
import { PasswordGate } from "./password-gate";
import type { CommentEntry } from "@/lib/events/comments";
import type { DatePoll } from "@/lib/events/date-poll";
import { readDatePoll } from "@/lib/events/read-date-poll";
import { buildEventOgMetadata } from "@/lib/events/og";
import {
  credentialSecret,
  passwordCookieName,
  verifyPasswordCredential,
} from "@/lib/events/password-credential";
import { isEventEnded } from "@/lib/events/format";
import { readComments } from "@/lib/events/read-comments";
import { readEventBySlug } from "@/lib/events/read-event";
import { createClient } from "@/lib/supabase/server";

/**
 * Public event page (task 2.4a) — `/{slug}`, the link a host shares with guests.
 *
 * PRIVATE CONVERGENCE (SCHEMA §3 / D3; task 禁止: "private 不得对 anon 裸奔"). The read
 * goes through `readEventBySlug`, which calls `get_event_by_slug` as the TRUSTED
 * service role. That RPC returns NULL for a private event to anyone who isn't
 * service_role, so a private event is reachable ONLY through this server path — an
 * anon client calling the RPC directly is turned away by the database. The SSR render
 * therefore never has to trust the client for the private gate.
 *
 * STRICT TIERING. At SSR there is no guest_token (it lives in the browser's
 * localStorage), so the SSR HTML always carries only the FIRST tier: title, host, date,
 * city, counts. The full address and guest list are second-tier — the data layer
 * doesn't return them here, so they can't be in the SSR HTML (TEST-SPEC §2.4: the
 * location sentinel must be absent until an RSVP unlocks it). The client `EventClient`
 * shell then runs the RSVP form (which mints the token) and the token-driven re-read
 * that reveals the address — all client-side, so the initial SSR payload stays locked.
 *
 * PASSWORD. A password-protected event comes back as the minimal locked façade
 * (`locked: true`); we hand it to <PasswordGate>, which verifies via the rate-limited
 * endpoint and reveals the event on success. On a RELOAD after a prior unlock the guest
 * carries the short-lived signed credential cookie (task 2.5); we validate it here and
 * pass `passwordVerified` so the trusted read resumes normal tiering without re-running
 * bcrypt (读/轮询不再重哈希) — the page renders the event directly, not the box.
 */
export const dynamic = "force-dynamic";

/**
 * Share-preview metadata (task 6.2 [SECURITY]) — the OG/Twitter card a messaging app
 * shows when the host's `/{slug}` link is pasted.
 *
 * FIRST TIER ONLY (task 禁止: "OG 不得泄露完整地址/名单"). We resolve the façade through
 * the trusted role with NO guest token and NO password credential, so `get_event_by_slug`
 * returns only the first tier (a password event returns just its locked title/cover/
 * description) — `location_text` and the guest list are never in scope. An unfurl bot
 * carries neither cookie nor localStorage token anyway, so this is exactly what it sees.
 * `buildEventOgMetadata` then reads only title/cover/description, so the card cannot
 * carry the address even for a private or password-protected event.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const event = await readEventBySlug(slug);
  return buildEventOgMetadata(event);
}

export default async function PublicEventPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await getTranslations("eventPage");

  // A returning guest of a password event carries the slug-scoped credential cookie
  // minted at unlock. Validate the cheap MAC; a valid one lets this SSR render skip the
  // password gate (no bcrypt). Absent/invalid ⇒ false ⇒ the locked façade + box.
  const credential = (await cookies()).get(passwordCookieName(slug))?.value ?? null;
  const passwordVerified = credential
    ? verifyPasswordCredential(slug, credential, credentialSecret())
    : false;

  // A logged-in viewer's account unlocks the event across devices WITHOUT a localStorage
  // token (audit H16 / D1): the SSR read goes through the trusted service role, where
  // auth.uid() is null, so we pass the authenticated user's id as the trusted viewer_id
  // and the RPC's account branch (guests.user_id = viewer_id) fires. Anon ⇒ null ⇒ no
  // account unlock, exactly as before.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No token at SSR — the guest_token is client-only (localStorage) and never rides
  // in the URL. First tier is all this render can resolve (plus the password gate, which
  // the credential above may open, and the account unlock above).
  const event = await readEventBySlug(slug, {
    passwordVerified,
    viewerId: user?.id ?? null,
  });
  if (!event) notFound();

  // Drafts aren't public yet. (A locked payload omits `status`, so this only fires on
  // the normal façade — a password event still shows its gate.) A CANCELLED event is
  // NOT hidden — it renders with a "cancelled" banner and no RSVP (audit B4), so guests
  // who hold the link learn it's off rather than RSVPing to a dead event.
  if (event.status === "draft") notFound();

  // "Ended" (audit H4): a concrete end in the past, or — for an event with a start but
  // no end — a few hours past its start (grace, so a just-started party isn't "ended").
  const ended = isEventEnded(event.starts_at ?? null, event.ends_at ?? null, event.date_tbd === true);

  // The Activity Feed (task 4.1) only renders past the password gate. For a visible
  // event we seed it server-side: comments are READ-OPEN (D6), so we fetch them through
  // the trusted role (which is also the ONLY path a private event's feed resolves on),
  // and we detect whether the viewer is the host — events SELECT RLS only returns the
  // row to its owner (host_id = auth.uid()), so a returned row IS proof of ownership,
  // and the host may always comment. Skipped behind a password box (nothing to show).
  let initialComments: CommentEntry[] = [];
  let initialPoll: DatePoll | null = null;
  let viewerIsHost = false;
  if (!event.locked) {
    if (user) {
      const { data: owned } = await supabase
        .from("events")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      viewerIsHost = owned != null;
    }
    initialComments = await readComments(slug);
    // Date poll (task 5.1): seed the read-open tally for a still-TBD event. No token at
    // SSR (it's client-only), so the guest's own selection resolves client-side on the
    // first token-bearing poll. Through the trusted role — a private event resolves only
    // here. Skipped for a fixed-date event (no live poll).
    if (event.date_tbd === true) initialPoll = await readDatePoll(slug);
  }

  return (
    <div className="flex min-h-full flex-col">
      {event.locked ? (
        <PasswordGate
          slug={slug}
          title={event.title}
          cover={event.cover_image_url ?? null}
          description={event.description ?? null}
        />
      ) : (
        <EventClient
          slug={slug}
          initialEvent={event}
          initialComments={initialComments}
          initialPoll={initialPoll}
          viewerIsHost={viewerIsHost}
          ended={ended}
        />
      )}

      <footer className="mt-auto px-5 py-8 text-center">
        <Link
          href="/"
          className="font-display text-sm font-bold tracking-tight text-muted transition hover:text-paper"
        >
          {t("madeWith")} JU<span className="text-coral">*</span>
        </Link>
      </footer>
    </div>
  );
}
