import Link from "next/link";
import { notFound } from "next/navigation";

import { EventView } from "./event-view";
import { PasswordGate } from "./password-gate";
import { readEventBySlug } from "@/lib/events/read-event";

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
 * localStorage), so the page always renders the FIRST tier: title, host, date, city,
 * counts. The full address and guest list are second-tier — the data layer doesn't
 * return them here, so they can't be in the SSR HTML (TEST-SPEC §2.4: the location
 * sentinel must be absent until an RSVP unlocks it). The token-driven re-read that
 * reveals the address, and the RSVP form that mints the token, arrive in task 2.4b.
 *
 * PASSWORD. A password-protected event comes back as the minimal locked façade
 * (`locked: true`); we hand it to <PasswordGate>, which verifies via the rate-limited
 * endpoint and reveals the event on success.
 */
export const dynamic = "force-dynamic";

export default async function PublicEventPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // No token at SSR — the guest_token is client-only (localStorage) and never rides
  // in the URL. First tier is all this render can resolve.
  const event = await readEventBySlug(slug);
  if (!event) notFound();

  // Drafts aren't public yet. (A locked payload omits `status`, so this only fires on
  // the normal façade — a password event still shows its gate.)
  if (event.status === "draft") notFound();

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
        <EventView event={event} />
      )}

      <footer className="mt-auto px-5 py-8 text-center">
        <Link
          href="/"
          className="font-display text-sm font-bold tracking-tight text-muted transition hover:text-paper"
        >
          made with partiful<span className="text-coral">*</span>
        </Link>
      </footer>
    </div>
  );
}
