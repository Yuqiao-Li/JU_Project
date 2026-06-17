"use client";

import { useEffect, useRef, useState } from "react";

import { type DatePoll as DatePollData } from "@/lib/events/date-poll";
import { formatOptionWhen } from "@/lib/events/format";

/**
 * Date poll (task 5.1) — the public event page's "when works for you?" vote.
 *
 * READ IS OPEN, VOTING IS GATED (mirrors the Activity Feed, D6/D4). Anyone who sees the
 * page sees the candidate dates and the live tally; a guest may only VOTE once UNLOCKED
 * (RSVP'd) — a locked viewer gets the count read-only and a prompt to RSVP. The gate is
 * the DB's (vote_dates re-checks the shared unlock helper); this UI's affordance just
 * mirrors it. Multi-select: the guest checks every date that works, and submitting sends
 * the COMPLETE selection (vote_dates replaces — de-selected dates are dropped). The tally
 * stays live through the parent's visibility-aware poll (the parent re-reads the event +
 * poll and feeds a fresh snapshot back here), so this never subscribes or reads a table.
 *
 * Rendered only while the poll is active (date_tbd, candidates exist, not finalized) —
 * once the host finalizes, the chosen date replaces the poll above and this unmounts.
 */
export function DatePoll({
  slug,
  poll,
  token,
  unlocked,
  accent,
  onVoted,
}: {
  slug: string;
  /** The current poll snapshot from the parent (kept live by its poll). */
  poll: DatePollData;
  /** The guest's own token (localStorage); null for a not-yet-RSVP'd guest. */
  token: string | null;
  /** Viewer's unlock state — a guest may vote only when RSVP'd. */
  unlocked: boolean;
  /** Host accent (events.theme.color) for the selected-date tint / submit. */
  accent: string;
  /** Hand a fresh poll snapshot back to the parent after a successful vote. */
  onVoted: (poll: DatePollData) => void;
}) {
  // Local working selection, seeded from the server's record of this guest's votes.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(poll.my_option_ids));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  const canVote = unlocked && token != null;

  // Re-seed the working selection when the server's record changes (a fresh poll arrives,
  // or a just-RSVP'd guest's token resolves their prior votes) — but never clobber edits
  // the guest is mid-way through for the SAME record.
  const appliedKey = useRef<string>(poll.my_option_ids.slice().sort().join(","));
  useEffect(() => {
    const key = poll.my_option_ids.slice().sort().join(",");
    if (key !== appliedKey.current) {
      appliedKey.current = key;
      setSelected(new Set(poll.my_option_ids));
    }
  }, [poll.my_option_ids]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSavedAt(0);
  }

  async function save() {
    if (busy || !canVote) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, option_ids: Array.from(selected) }),
      });
      const data: unknown = await res.json().catch(() => null);
      const ok = !!data && typeof data === "object" && (data as { ok?: unknown }).ok === true;
      if (!res.ok || !ok) {
        const message =
          data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string"
            ? (data as { message: string }).message
            : "Couldn’t save your vote. Try again.";
        setError(message);
        return;
      }
      const fresh = (data as { poll?: DatePollData }).poll;
      if (fresh) {
        appliedKey.current = fresh.my_option_ids.slice().sort().join(",");
        setSelected(new Set(fresh.my_option_ids));
        onVoted(fresh);
      }
      setSavedAt(Date.now());
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // Dirty = the working selection differs from what the server has on record.
  const recorded = new Set(poll.my_option_ids);
  const dirty =
    selected.size !== recorded.size || Array.from(selected).some((id) => !recorded.has(id));

  return (
    <section className="mt-10 rounded-2xl border border-line bg-surface/50 p-5 sm:p-6">
      <p className="eyebrow">Pick a date</p>
      <p className="mt-2 text-paper/90">
        {canVote
          ? "Check every date that works for you."
          : "Vote on when this should happen — RSVP first to weigh in."}
      </p>

      <ul className="mt-4 space-y-2" role="group" aria-label="Candidate dates">
        {poll.options.map((o) => {
          const checked = selected.has(o.id);
          return (
            <li key={o.id}>
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                  checked ? "border-transparent" : "border-line bg-ink/30 hover:bg-surface-2"
                } ${canVote ? "" : "cursor-default"}`}
                style={checked ? { backgroundColor: `${accent}26`, borderColor: accent } : undefined}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!canVote || busy}
                  onChange={() => toggle(o.id)}
                  className="size-4 accent-coral"
                  style={checked ? { accentColor: accent } : undefined}
                />
                <span className="min-w-0 flex-1 text-paper">{formatOptionWhen(o.starts_at, o.ends_at)}</span>
                <span className="shrink-0 text-sm text-muted">
                  {o.votes} {o.votes === 1 ? "vote" : "votes"}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className="mt-3 text-sm text-coral">
          {error}
        </p>
      )}

      {canVote ? (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty}
            aria-busy={busy}
            className="inline-flex h-11 items-center justify-center rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
            style={!busy && dirty ? { backgroundColor: accent } : undefined}
          >
            {busy ? "Saving…" : "Save vote"}
          </button>
          {savedAt > 0 && !dirty && <span className="text-sm text-muted">Saved.</span>}
        </div>
      ) : (
        <p className="mt-4">
          <a href="#rsvp" className="text-sm font-medium text-iris underline-offset-2 hover:underline">
            RSVP
          </a>{" "}
          <span className="text-sm text-muted">to vote on the date.</span>
        </p>
      )}
    </section>
  );
}
