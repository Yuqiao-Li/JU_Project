"use client";

import { useEffect, useRef, useState } from "react";

import {
  RSVP_STATUSES,
  rsvpInputSchema,
  rsvpResultSchema,
  type RsvpResult,
  type RsvpStatus,
} from "@/lib/events/rsvp";
import type { RsvpRecord } from "@/lib/events/rsvp-storage";

/**
 * RSVP form (task 2.4b) — the signature interaction of the public event page.
 *
 * A guest replies with just a name (no account), an optional +1 count, and an optional
 * contact. We POST to the trusted submit route, which calls `submit_rsvp`; on success
 * the parent stores the returned guest_token in localStorage and re-reads the event to
 * reveal the unlocked view (full address / list). The token never touches this form's
 * URL or markup — it travels only in the POST body the parent later replays.
 *
 * Capacity is the DB's call, not ours: when the event is full we say so and frame a
 * 'going' reply as joining the waitlist, but the authoritative outcome is whatever
 * `submit_rsvp` returns (it may downgrade 'going' → 'waitlisted' under its lock), shown
 * back in the confirmation. When the host turned RSVPs off there is no guest input at
 * all (host-only, D6) — just a quiet notice.
 */

const STATUS_LABELS: Record<RsvpStatus, string> = {
  going: "I’m going",
  maybe: "Maybe",
  not_going: "Can’t go",
};

interface RsvpFormProps {
  slug: string;
  /** Event accent (events.theme.color) — the one place to spend a little boldness. */
  accent: string;
  rsvpEnabled: boolean;
  allowPlusOnes: boolean;
  maxPlusOnes: number;
  /** capacity_remaining === 0 — frame a 'going' reply as the waitlist. */
  isFull: boolean;
  /** The guest's cached RSVP (return visit) for prefill, or null for a first reply. */
  initial: RsvpRecord | null;
  onSubmitted: (
    result: RsvpResult,
    input: { display_name: string; status: RsvpStatus; plus_ones: number; contact: string | null },
  ) => void;
}

export function RsvpForm({
  slug,
  accent,
  rsvpEnabled,
  allowPlusOnes,
  maxPlusOnes,
  isFull,
  initial,
  onSubmitted,
}: RsvpFormProps) {
  const [name, setName] = useState(initial?.display_name ?? "");
  const [status, setStatus] = useState<RsvpStatus>(coerceStatus(initial?.status));
  const [plusOnes, setPlusOnes] = useState(initial?.plus_ones ?? 0);
  const [contact, setContact] = useState(initial?.contact ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<RsvpResult | null>(null);

  // The parent recovers the cached RSVP from localStorage AFTER mount, so `initial`
  // arrives a tick late on a return visit. Re-seed the fields when a DIFFERENT record
  // shows up (new token), but never clobber edits the guest is in the middle of typing
  // for the same record (same token → skip).
  const appliedToken = useRef<string | null>(initial?.token ?? null);
  useEffect(() => {
    if (initial && initial.token !== appliedToken.current) {
      appliedToken.current = initial.token;
      setName(initial.display_name);
      setStatus(coerceStatus(initial.status));
      setPlusOnes(initial.plus_ones);
      setContact(initial.contact ?? "");
    }
  }, [initial]);

  if (!rsvpEnabled) {
    return (
      <section id="rsvp" className="mt-10 rounded-2xl border border-line bg-surface/50 p-5">
        <p className="eyebrow">RSVP</p>
        <p className="mt-2 text-paper/90">
          The host turned off replies for this one — keep an eye here for updates.
        </p>
      </section>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    const candidate = {
      display_name: name,
      status,
      plus_ones: allowPlusOnes ? plusOnes : 0,
      contact: contact.trim() ? contact.trim() : null,
      guest_token: initial?.token ?? null,
    };
    const parsed = rsvpInputSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form and try again.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/rsvp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (res.status === 429) {
        setError("Too many tries — wait a moment and try again.");
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const ok = !!data && typeof data === "object" && (data as { ok?: unknown }).ok === true;
      if (!res.ok || !ok) {
        const message =
          (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string"
            ? (data as { message: string }).message
            : null) ?? "Couldn’t save your RSVP. Try again.";
        setError(message);
        return;
      }

      const result = rsvpResultSchema.safeParse((data as { rsvp?: unknown }).rsvp);
      if (!result.success) {
        setError("Something went wrong saving your RSVP. Try again.");
        return;
      }

      setConfirmed(result.data);
      onSubmitted(result.data, {
        display_name: parsed.data.display_name,
        status,
        plus_ones: parsed.data.plus_ones,
        contact: parsed.data.contact ?? null,
      });
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const hasReplied = confirmed != null || initial != null;
  const submitLabel = busy ? "Saving…" : hasReplied ? "Update RSVP" : "RSVP";

  return (
    <section id="rsvp" className="mt-10 rounded-2xl border border-line bg-surface/50 p-5 sm:p-6">
      <p className="eyebrow">RSVP</p>

      {confirmed ? (
        <p className="mt-2 font-medium text-paper">{confirmationLine(confirmed)}</p>
      ) : (
        <p className="mt-2 text-paper/90">
          {isFull
            ? "This event is full — reply to join the waitlist. No account needed."
            : "Reply to save your spot — no account needed."}
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        {/* Status — the bold choice, tinted with the host's accent when selected. */}
        <fieldset>
          <legend className="sr-only">Your reply</legend>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Your reply">
            {RSVP_STATUSES.map((s) => {
              const selected = status === s;
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setStatus(s)}
                  className={`h-11 rounded-xl border text-sm font-semibold transition ${
                    selected
                      ? "border-transparent text-ink"
                      : "border-line bg-ink/30 text-paper hover:bg-surface-2"
                  }`}
                  style={selected ? { backgroundColor: accent } : undefined}
                >
                  {s === "going" && isFull ? "Join waitlist" : STATUS_LABELS[s]}
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Name — the only required field. */}
        <div>
          <label htmlFor="rsvp-name" className="block text-sm font-medium text-paper">
            Your name
          </label>
          <input
            id="rsvp-name"
            name="display_name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="e.g. Alex Chen"
            className="mt-1.5 h-11 w-full rounded-xl border border-line bg-ink/40 px-3.5 text-paper placeholder:text-muted/60 focus-visible:border-iris"
          />
        </div>

        {/* Plus-ones — only when the host allows them. */}
        {allowPlusOnes && status === "going" && maxPlusOnes > 0 && (
          <div>
            <label htmlFor="rsvp-plus-ones" className="block text-sm font-medium text-paper">
              Bringing anyone? <span className="text-muted">(up to {maxPlusOnes})</span>
            </label>
            <select
              id="rsvp-plus-ones"
              value={plusOnes}
              onChange={(e) => setPlusOnes(Number(e.target.value))}
              className="mt-1.5 h-11 w-full rounded-xl border border-line bg-ink/40 px-3 text-paper focus-visible:border-iris"
            >
              {Array.from({ length: maxPlusOnes + 1 }, (_, n) => (
                <option key={n} value={n}>
                  {n === 0 ? "Just me" : `+${n}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Contact — optional; host-visible metadata only, never an identity key (D1). */}
        <div>
          <label htmlFor="rsvp-contact" className="block text-sm font-medium text-paper">
            Email or phone <span className="text-muted">(optional)</span>
          </label>
          <input
            id="rsvp-contact"
            name="contact"
            type="text"
            autoComplete="off"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={200}
            placeholder="So the host can reach you"
            className="mt-1.5 h-11 w-full rounded-xl border border-line bg-ink/40 px-3.5 text-paper placeholder:text-muted/60 focus-visible:border-iris"
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-coral">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
        >
          {submitLabel}
        </button>
      </form>
    </section>
  );
}

/** Coerce a cached/loose status to a valid requested status (waitlisted edits as going). */
function coerceStatus(value: string | undefined): RsvpStatus {
  return (RSVP_STATUSES as readonly string[]).includes(value ?? "") ? (value as RsvpStatus) : "going";
}

/** Friendly confirmation reflecting the CONFIRMED server outcome (may be waitlisted). */
function confirmationLine(result: RsvpResult): string {
  if (result.waitlisted || result.status === "waitlisted") {
    return "You’re on the waitlist — we’ll let you know if a spot opens up.";
  }
  switch (result.status) {
    case "going":
      return "You’re in 🎉 Update your reply anytime below.";
    case "maybe":
      return "Marked as maybe — change it anytime below.";
    case "not_going":
      return "Got it — you’re not going. You can change your mind below.";
    default:
      return "Your reply is saved. Update it anytime below.";
  }
}
