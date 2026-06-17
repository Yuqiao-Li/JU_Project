"use client";

import { useCallback, useEffect, useState } from "react";

import {
  commentInputSchema,
  formatCommentTime,
  parseComments,
  type CommentEntry,
} from "@/lib/events/comments";

/**
 * Activity Feed (task 4.1) — the public event page's comment stream.
 *
 * READ IS OPEN, WRITE IS GATED (SCHEMA D6; TEST-SPEC §4.1). Anyone who can see the page
 * can READ the feed — so this renders for locked and unlocked viewers alike and keeps
 * itself live by VISIBILITY-AWARE POLLING (D4): a plain re-read of get_comments every
 * {@link POLL_INTERVAL_MS} while the tab is visible, paused when hidden — NOT a realtime
 * subscription, NEVER a direct table read. POSTING is gated, and the gate is the DB's:
 *  - a guest may post only once UNLOCKED (RSVP'd); a locked guest sees a prompt to RSVP
 *    instead of a composer (未解锁不得发);
 *  - when the host turned RSVPs off the feed is HOST-ONLY — the guest composer is hidden
 *    entirely (rsvp_enabled=false ⇒ guest 隐藏输入框);
 *  - the host may always post.
 * The composer's presence here is only an affordance; the real gate is `add_comment`,
 * which rejects a forged/locked write regardless of what this UI shows.
 *
 * MVP IS PLAIN TEXT (D6): no GIF surface — just text bodies. Author identity is a name
 * plus a host badge; no guest_id / token / contact ever reaches this component (the RPC
 * omits them and parseComments strips anything off-contract).
 */

/** Feed poll cadence while the tab is in front of the viewer — 4 reads/min, well inside
 *  the lenient `event_poll` quota when a token is present (interval aligned to the
 *  window so a normal poller is never falsely limited, D4). */
const POLL_INTERVAL_MS = 15_000;

export function CommentsFeed({
  slug,
  initialComments,
  unlocked,
  rsvpEnabled,
  viewerIsHost,
  hideTimestamps,
  token,
  accent,
}: {
  slug: string;
  initialComments: CommentEntry[];
  /** Viewer's unlock state — a guest may post only when RSVP'd. */
  unlocked: boolean;
  /** events.rsvp_enabled — when false the feed is host-only (hide the guest composer). */
  rsvpEnabled: boolean;
  /** True when the logged-in viewer owns this event (host may always post). */
  viewerIsHost: boolean;
  /** events.hide_feed_timestamps — pure render; the RPC still returns created_at. */
  hideTimestamps: boolean;
  /** The guest's own token (localStorage) for posting; null for a not-yet-RSVP'd guest. */
  token: string | null;
  /** Host accent (events.theme.color) for the host badge / submit tint. */
  accent: string;
}) {
  const [comments, setComments] = useState<CommentEntry[]>(initialComments);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justPosted, setJustPosted] = useState(false);

  const applyComments = useCallback((next: CommentEntry[] | null) => {
    if (next) setComments(next);
  }, []);

  // Read-open feed poll: refresh from get_comments while the tab is visible, regardless
  // of token (a locked viewer still sees the feed). An immediate read on mount keeps the
  // feed fresh and seeds it even when mounted without SSR comments (the password gate's
  // client-side reveal). Regaining focus triggers a catch-up.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled || document.visibilityState !== "visible") return;
      const next = await fetchComments(slug, token);
      if (!cancelled) applyComments(next);
    }

    void poll();
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
  }, [slug, token, applyComments]);

  // Who may post: the host always; a guest only when RSVPs are on AND they're unlocked.
  // A locked guest gets the RSVP prompt; with RSVPs off the guest composer is hidden.
  const canCompose = viewerIsHost || (rsvpEnabled && unlocked);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setJustPosted(false);

    const parsed = commentInputSchema.safeParse({ body, token });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your comment.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data: unknown = await res.json().catch(() => null);
      const ok = !!data && typeof data === "object" && (data as { ok?: unknown }).ok === true;
      if (!res.ok || !ok) {
        const message =
          data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string"
            ? (data as { message: string }).message
            : "Couldn’t post your comment. Try again.";
        setError(message);
        return;
      }

      // Clear the box and re-read so the new comment shows on the next feed read (it is
      // already in the DB) — same posture as the rest of the page's poll-don't-push model.
      setBody("");
      setJustPosted(true);
      const next = await fetchComments(slug, token);
      applyComments(next);
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="eyebrow">Activity</h2>

      {/* Feed — oldest → newest, as the RPC returns it. */}
      {comments.length === 0 ? (
        <p className="mt-3 text-muted">No comments yet — say hi 👋</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {comments.map((c) => (
            <li
              key={c.id}
              className="guest-enter rounded-2xl border border-line bg-surface/50 px-4 py-3"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-semibold text-paper">
                  {c.author_display_name ?? "Guest"}
                </span>
                {c.is_host && (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink"
                    style={{ backgroundColor: accent }}
                  >
                    Host
                  </span>
                )}
                {!hideTimestamps && (
                  <time dateTime={c.created_at} className="text-xs text-muted">
                    {formatCommentTime(c.created_at)}
                  </time>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-paper/90">
                {c.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      {/* Composer / gate. */}
      <div className="mt-4">
        {canCompose ? (
          <form onSubmit={handleSubmit} className="space-y-2">
            <label htmlFor="comment-body" className="sr-only">
              Add a comment
            </label>
            <textarea
              id="comment-body"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                if (justPosted) setJustPosted(false);
              }}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter sends, like most chat composers.
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              rows={2}
              maxLength={2000}
              placeholder={viewerIsHost ? "Post an update…" : "Add a comment…"}
              className="w-full resize-y rounded-xl border border-line bg-ink/40 px-3.5 py-2.5 text-paper placeholder:text-muted/60 focus-visible:border-iris"
            />
            {error && (
              <p role="alert" className="text-sm text-coral">
                {error}
              </p>
            )}
            {justPosted && !error && (
              <p className="text-sm text-muted">Posted.</p>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy || body.trim().length === 0}
                aria-busy={busy}
                className="inline-flex h-10 items-center justify-center rounded-xl bg-coral px-4 text-sm font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
              >
                {busy ? "Posting…" : "Post"}
              </button>
            </div>
          </form>
        ) : rsvpEnabled ? (
          // Locked guest: read-open, but posting needs an RSVP (未解锁点发提示先RSVP).
          <p className="rounded-xl border border-line bg-surface/40 px-4 py-3 text-sm text-muted">
            <a href="#rsvp" className="font-medium text-iris underline-offset-2 hover:underline">
              RSVP
            </a>{" "}
            to join the conversation.
          </p>
        ) : (
          // RSVPs off ⇒ host-only feed: no guest composer at all (guest 隐藏输入框).
          <p className="rounded-xl border border-line bg-surface/40 px-4 py-3 text-sm text-muted">
            Only the host can post here.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Read the comment feed via the trusted poll endpoint. Returns the validated list, or
 * null when the read failed — callers keep whatever they already show rather than
 * blanking the feed on a transient error. The token (when present) only selects the
 * lenient poll quota; it travels in the query the app builds, never a shareable URL.
 */
async function fetchComments(slug: string, token: string | null): Promise<CommentEntry[] | null> {
  try {
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    const res = await fetch(`/api/events/${encodeURIComponent(slug)}/comments${qs}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data: unknown = await res.json().catch(() => null);
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    return parseComments(obj?.comments);
  } catch {
    return null;
  }
}
