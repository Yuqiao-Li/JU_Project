"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { EventView } from "./event-view";
import { CommentsFeed } from "@/components/events/comments-feed";
import { DatePoll } from "@/components/events/date-poll";
import { GuestList } from "@/components/events/guest-list";
import { RsvpForm } from "@/components/events/rsvp-form";
import type { CommentEntry } from "@/lib/events/comments";
import { isEventEnded } from "@/lib/events/format";
import { parseDatePoll, pollIsActive, type DatePoll as DatePollData } from "@/lib/events/date-poll";
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
  poll: DatePollData | null;
}

/**
 * Outcome of a tiered re-read, so callers can tell "unlock failed" from "re-locked".
 *  - `ok`     — a fresh unlocked snapshot to apply.
 *  - `locked` — the read came back as a password lock (credential cookie gone, task
 *               2.5); IGNORED so we never clobber a good view with a re-locked one.
 *  - `failed` — the read genuinely failed (network / non-ok / 404 / parse); the post-
 *               submit path surfaces a retry rather than silently freezing (audit H14).
 */
type SnapshotResult =
  | { kind: "ok"; snapshot: EventSnapshot }
  | { kind: "locked" }
  | { kind: "failed" };

export function EventClient({
  slug,
  initialEvent,
  initialComments,
  initialPoll,
  viewerIsHost,
  ended,
}: {
  slug: string;
  initialEvent: EventViewData;
  /** SSR-fetched comment feed (read-open, task 4.1); the feed re-polls client-side. */
  initialComments: CommentEntry[];
  /** SSR-fetched date poll (read-open tally, task 5.1); null when there's no live poll. */
  initialPoll: DatePollData | null;
  /** True when the logged-in viewer owns this event (host may always comment). */
  viewerIsHost: boolean;
  /**
   * True when the event's time has passed (audit H4); gates RSVP/voting/calendar.
   * Provided (server-computed) on the SSR path; omitted on the password-unlock path,
   * where it's derived client-side from the revealed event's dates.
   */
  ended?: boolean;
}) {
  const t = useTranslations("eventPage");
  const [event, setEvent] = useState<EventViewData>(initialEvent);
  const [guests, setGuests] = useState<GuestListEntry[]>([]);
  const [poll, setPoll] = useState<DatePollData | null>(initialPoll);
  const [record, setRecord] = useState<RsvpRecord | null>(null);
  // Post-submit unlock progress (audit H14): "loading" while the re-read runs, "failed"
  // when it genuinely fails (not a re-lock) so the guest gets a retry instead of a silent
  // freeze. Idle the rest of the time (background polling never sets these).
  const [unlockState, setUnlockState] = useState<"idle" | "loading" | "failed">("idle");
  const token = record?.token ?? null;

  // Apply a fresh re-read. A `locked`/`failed` result is IGNORED so a transient error or
  // a re-locked read never clobbers an already-unlocked view. The poll is only updated
  // when the re-read actually carried one (a fixed-date event returns none).
  const applySnapshot = useCallback((result: SnapshotResult) => {
    if (result.kind !== "ok") return;
    setEvent(result.snapshot.event);
    setGuests(result.snapshot.guests);
    if (result.snapshot.poll) setPoll(result.snapshot.poll);
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
    input: {
      display_name: string;
      status: RsvpStatus;
      plus_ones: number;
      contact: string | null;
      wechat_id: string | null;
    },
  ) {
    const rec: RsvpRecord = {
      token: result.guest_token,
      status: result.status,
      plus_ones: result.plus_ones,
      display_name: input.display_name,
      contact: input.contact,
      wechat_id: input.wechat_id,
    };
    saveRsvpRecord(slug, rec);
    setRecord(rec);

    // Re-read with the (possibly newly minted) token to reveal the unlocked tier and the
    // guest list now that this guest is on it. Show a brief loading state, and if the
    // re-read GENUINELY fails (not a re-lock), surface a retry so the guest isn't left on
    // a frozen first-tier page after a "You're in" with zero feedback (audit H14).
    setUnlockState("loading");
    const result2 = await fetchSnapshot(slug, result.guest_token);
    applySnapshot(result2);
    setUnlockState(result2.kind === "failed" ? "failed" : "idle");
  }

  // Manual retry for a failed post-submit unlock (audit H14). Re-reads with the stored
  // token; on success the unlocked tier appears, on failure the retry affordance stays.
  const retryUnlock = useCallback(async () => {
    if (!token) {
      setUnlockState("idle");
      return;
    }
    setUnlockState("loading");
    const result = await fetchSnapshot(slug, token);
    applySnapshot(result);
    setUnlockState(result.kind === "failed" ? "failed" : "idle");
  }, [slug, token, applySnapshot]);

  const accent = themeSwatch(themeColorFromJson(event.theme)).hex;
  const isFull = event.capacity_remaining === 0;
  // Server-provided on the SSR path; on the password-unlock path it's omitted, so
  // derive it from the revealed event's dates (client-side).
  const effectiveEnded =
    ended ?? isEventEnded(event.starts_at ?? null, event.ends_at ?? null, event.date_tbd === true);

  return (
    <EventView
      event={event}
      ended={effectiveEnded}
      rsvpSlot={
        <>
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
          {unlockState === "loading" && (
            <p role="status" className="mt-3 text-sm text-muted">
              {t("unlockLoading")}
            </p>
          )}
          {unlockState === "failed" && (
            <div
              role="alert"
              className="mt-3 flex flex-wrap items-center gap-2 text-sm text-paper/90"
            >
              <span>{t("unlockFailed")}</span>
              <button
                type="button"
                onClick={() => void retryUnlock()}
                className="font-semibold text-iris underline-offset-2 hover:underline"
              >
                {t("unlockRetry")}
              </button>
            </div>
          )}
        </>
      }
      pollSlot={
        pollIsActive(poll) ? (
          <DatePoll
            slug={slug}
            poll={poll}
            token={token}
            unlocked={event.unlocked === true}
            accent={accent}
            onVoted={setPoll}
          />
        ) : null
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
async function fetchSnapshot(slug: string, token: string): Promise<SnapshotResult> {
  try {
    const res = await fetch(
      `/api/events/${encodeURIComponent(slug)}?token=${encodeURIComponent(token)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return { kind: "failed" };
    const data: unknown = await res.json().catch(() => null);
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const parsed = eventViewSchema.safeParse(obj?.event);
    if (!parsed.success) return { kind: "failed" };
    // A re-locked password event (credential cookie gone, task 2.5): not a failure —
    // we deliberately keep whatever good view we already show rather than re-locking it.
    if (parsed.data.locked) return { kind: "locked" };
    return {
      kind: "ok",
      snapshot: {
        event: parsed.data,
        guests: parseGuestList(obj?.guests),
        poll: parseDatePoll(obj?.poll),
      },
    };
  } catch {
    return { kind: "failed" };
  }
}
