"use client";

import { useCallback, useEffect, useState } from "react";

import { EventView } from "./event-view";
import { CommentsFeed } from "@/components/events/comments-feed";
import { GuestList } from "@/components/events/guest-list";
import { RsvpForm } from "@/components/events/rsvp-form";
import type { CommentEntry } from "@/lib/events/comments";
import { parseGuestList, type GuestListEntry } from "@/lib/events/guest-list";
import {
  loadRsvpRecord,
  saveRsvpRecord,
  type RsvpRecord,
} from "@/lib/events/rsvp-storage";
import type { RsvpResult, RsvpStatus } from "@/lib/events/rsvp";
import { themeColorFromJson, themeSwatch } from "@/lib/events/theme";
import { eventViewSchema, type EventView as EventViewData } from "@/lib/events/view";

/**
 * Client shell for the public event page (tasks 2.4b + 3.1) — wires the RSVP
 * interaction, the token-driven unlock, and the live guest list onto the SSR façade.
 *
 * SSR renders only the FIRST tier (no token exists server-side — it lives in
 * localStorage and never rides the URL) and seeds this component via `initialEvent`.
 * Here, client-side, the guest_token recovered from localStorage drives our OWN poll
 * endpoint, which proxies the trusted-role read. That single tiered funnel returns BOTH
 * the unlocked event façade (full address) AND the desensitized guest list — so:
 *  - a returning guest re-sees the unlocked tier without the token ever appearing in a
 *    shareable place, and a private event still resolves only through our trusted hop;
 *  - the "who's coming" list stays live via VISIBILITY-AWARE POLLING (task 3.1, D4):
 *    a plain re-read of the tiered RPC every {@link POLL_INTERVAL_MS} while the tab is
 *    visible, paused when hidden — NOT a realtime subscription, NEVER a direct table
 *    read. The lenient `event_poll` quota (token present) keeps normal polling un-429'd.
 *
 * STRICT TIERING stays a DATA fact, not a CSS one: the address and the list only ever
 * show because the re-read returned them for an unlocked caller — we never synthesise
 * them. A re-read that comes back LOCKED (invalid token, or a password event whose
 * credential cookie is gone — task 2.5) is ignored so we never overwrite a good view
 * with a re-locked one.
 */

/** Poll cadence while a token-holding guest has the tab in front of them. 4 reads/min —
 *  well inside the lenient `event_poll` quota (120/60s), interval aligned to the window
 *  so a normal poller is never falsely limited (D4). */
const POLL_INTERVAL_MS = 15_000;

interface EventSnapshot {
  event: EventViewData;
  guests: GuestListEntry[];
}

export function EventClient({
  slug,
  initialEvent,
  initialComments,
  viewerIsHost,
}: {
  slug: string;
  initialEvent: EventViewData;
  /** SSR-fetched comment feed (read-open, task 4.1); the feed re-polls client-side. */
  initialComments: CommentEntry[];
  /** True when the logged-in viewer owns this event (host may always comment). */
  viewerIsHost: boolean;
}) {
  const [event, setEvent] = useState<EventViewData>(initialEvent);
  const [guests, setGuests] = useState<GuestListEntry[]>([]);
  const [record, setRecord] = useState<RsvpRecord | null>(null);
  const token = record?.token ?? null;

  // Apply a fresh re-read. A null snapshot (failed / locked) is IGNORED so a transient
  // error or a re-locked read never clobbers an already-unlocked view.
  const applySnapshot = useCallback((snap: EventSnapshot | null) => {
    if (!snap) return;
    setEvent(snap.event);
    setGuests(snap.guests);
  }, []);

  // localStorage is client-only, so the cached RSVP (and thus the unlocked re-read) can
  // only be recovered after mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rec = loadRsvpRecord(slug);
      if (!rec || cancelled) return;
      setRecord(rec);
      const snap = await fetchSnapshot(slug, rec.token);
      if (!cancelled) applySnapshot(snap);
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, applySnapshot]);

  // Visibility-aware polling (task 3.1, D4): only while a token exists AND the tab is
  // visible. The interval skips work when hidden; regaining focus triggers an immediate
  // catch-up read. Keyed on the token so it resets cleanly when the guest (re-)RSVPs.
  useEffect(() => {
    if (!token) return;
    const activeToken = token;
    let cancelled = false;

    async function poll() {
      if (cancelled || document.visibilityState !== "visible") return;
      const snap = await fetchSnapshot(slug, activeToken);
      if (!cancelled) applySnapshot(snap);
    }

    const id = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [slug, token, applySnapshot]);

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

    // Re-read with the (possibly newly minted) token to reveal the unlocked tier and the
    // guest list now that this guest is on it.
    const snap = await fetchSnapshot(slug, result.guest_token);
    applySnapshot(snap);
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
      guestListSlot={
        <GuestList
          guests={guests}
          unlocked={event.unlocked === true}
          hidden={event.hide_guest_list === true}
          showCounts={event.hide_guest_count !== true}
          accent={accent}
        />
      }
      commentsSlot={
        <CommentsFeed
          slug={slug}
          initialComments={initialComments}
          unlocked={event.unlocked === true}
          rsvpEnabled={event.rsvp_enabled !== false}
          viewerIsHost={viewerIsHost}
          hideTimestamps={event.hide_feed_timestamps === true}
          token={token}
          accent={accent}
        />
      }
    />
  );
}

/**
 * Read the tiered event + guest list via our poll endpoint (token in the query the app
 * builds, not a shared URL). Returns the unlocked façade with its list, or null when the
 * read failed / 404'd / came back locked — callers keep whatever they already show
 * rather than re-locking it.
 */
async function fetchSnapshot(slug: string, token: string): Promise<EventSnapshot | null> {
  try {
    const res = await fetch(
      `/api/events/${encodeURIComponent(slug)}?token=${encodeURIComponent(token)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data: unknown = await res.json().catch(() => null);
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const parsed = eventViewSchema.safeParse(obj?.event);
    if (!parsed.success || parsed.data.locked) return null;
    return { event: parsed.data, guests: parseGuestList(obj?.guests) };
  } catch {
    return null;
  }
}
