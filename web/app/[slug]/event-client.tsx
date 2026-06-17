"use client";

import { useEffect, useState } from "react";

import { EventView } from "./event-view";
import { RsvpForm } from "@/components/events/rsvp-form";
import {
  loadRsvpRecord,
  saveRsvpRecord,
  type RsvpRecord,
} from "@/lib/events/rsvp-storage";
import type { RsvpResult, RsvpStatus } from "@/lib/events/rsvp";
import { themeColorFromJson, themeSwatch } from "@/lib/events/theme";
import { eventViewSchema, type EventView as EventViewData } from "@/lib/events/view";

/**
 * Client shell for the public event page (task 2.4b) — wires the RSVP interaction and
 * the token-driven unlock onto the SSR-rendered façade.
 *
 * SSR renders only the FIRST tier (no token exists server-side — it lives in
 * localStorage and never rides the URL), and seeds this component via `initialEvent`.
 * Here, client-side:
 *  - On mount we recover the guest's token from localStorage and, if present, re-read
 *    the event through our OWN poll endpoint WITH the token. That endpoint proxies the
 *    trusted-role read, so a returning guest re-sees the unlocked tier (full address)
 *    without the token ever appearing in a shareable place, and a private event still
 *    only resolves through our trusted server hop — never a direct anon RPC call.
 *  - After a successful RSVP we persist the returned token, then re-read with it so the
 *    just-unlocked view (address / list entry) appears in place (D15).
 *
 * STRICT TIERING stays a DATA fact, not a CSS one: the address only ever shows because
 * the re-read returned `location_text` for an unlocked caller — we never synthesise it.
 * A re-read that comes back LOCKED (e.g. a password event before its 2.5 credential, or
 * an invalid token) is ignored so we never overwrite a good view with a re-locked one.
 */
export function EventClient({
  slug,
  initialEvent,
}: {
  slug: string;
  initialEvent: EventViewData;
}) {
  const [event, setEvent] = useState<EventViewData>(initialEvent);
  const [record, setRecord] = useState<RsvpRecord | null>(null);

  // localStorage is client-only, so the cached RSVP (and thus the unlocked re-read)
  // can only be recovered after mount — both state updates happen inside the async
  // recovery, not synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rec = loadRsvpRecord(slug);
      if (!rec || cancelled) return;
      setRecord(rec);
      const fresh = await fetchEvent(slug, rec.token);
      if (!cancelled && fresh) setEvent(fresh);
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function handleSubmitted(
    result: RsvpResult,
    input: { display_name: string; status: RsvpStatus; plus_ones: number; contact: string | null },
  ) {
    const rec: RsvpRecord = {
      token: result.guest_token,
      status: result.status,
      plus_ones: result.plus_ones,
      display_name: input.display_name,
      contact: input.contact,
    };
    saveRsvpRecord(slug, rec);
    setRecord(rec);

    // Re-read with the (possibly newly minted) token to reveal the unlocked tier.
    const fresh = await fetchEvent(slug, result.guest_token);
    if (fresh) setEvent(fresh);
  }

  const accent = themeSwatch(themeColorFromJson(event.theme)).hex;
  const isFull = event.capacity_remaining === 0;

  return (
    <EventView
      event={event}
      rsvpSlot={
        <RsvpForm
          slug={slug}
          accent={accent}
          rsvpEnabled={event.rsvp_enabled !== false}
          allowPlusOnes={event.allow_plus_ones === true}
          maxPlusOnes={event.max_plus_ones ?? 1}
          isFull={isFull}
          initial={record}
          onSubmitted={handleSubmitted}
        />
      }
    />
  );
}

/**
 * Read the tiered event via our poll endpoint (token in the query the app builds, not a
 * shared URL). Returns the unlocked façade, or null when the read failed / 404'd / came
 * back locked — callers keep whatever they already show rather than re-locking it.
 */
async function fetchEvent(slug: string, token: string): Promise<EventViewData | null> {
  try {
    const res = await fetch(
      `/api/events/${encodeURIComponent(slug)}?token=${encodeURIComponent(token)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data: unknown = await res.json().catch(() => null);
    const raw = data && typeof data === "object" ? (data as { event?: unknown }).event : null;
    const parsed = eventViewSchema.safeParse(raw);
    if (!parsed.success || parsed.data.locked) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
