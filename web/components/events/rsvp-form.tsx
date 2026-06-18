"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

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

const STATUS_LABEL_KEYS: Record<RsvpStatus, string> = {
  going: "statusGoing",
  maybe: "statusMaybe",
  not_going: "statusNotGoing",
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
  const t = useTranslations("rsvp");
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
        <p className="eyebrow">{t("eyebrow")}</p>
        <p className="mt-2 text-paper/90">{t("disabledNotice")}</p>
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
      setError(parsed.error.issues[0]?.message ?? t("errorCheckForm"));
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
        setError(t("errorTooMany"));
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const ok = !!data && typeof data === "object" && (data as { ok?: unknown }).ok === true;
      if (!res.ok || !ok) {
        const message =
          (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string"
            ? (data as { message: string }).message
            : null) ?? t("errorSaveFailed");
        setError(message);
        return;
      }

      const result = rsvpResultSchema.safeParse((data as { rsvp?: unknown }).rsvp);
      if (!result.success) {
        setError(t("errorSaveWrong"));
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
      setError(t("errorNetwork"));
    } finally {
      setBusy(false);
    }
  }

  const hasReplied = confirmed != null || initial != null;
  const submitLabel = busy ? t("submitSaving") : hasReplied ? t("submitUpdate") : t("submitRsvp");

  // `isFull` is an EVENT-level flag (capacity_remaining === 0), but `submit_rsvp`
  // EXCLUDES the caller's own row from the occupancy check — so a viewer who ALREADY
  // holds a going seat keeps it when they re-confirm. Only frame a 'going' reply as the
  // waitlist for someone who isn't already going; otherwise the button would lie about
  // their own re-confirmation costing them their seat (audit M26). The server-confirmed
  // status (if any) wins over the cached one.
  const viewerIsGoing = (confirmed?.status ?? initial?.status) === "going";
  const framesWaitlist = isFull && !viewerIsGoing;

  return (
    <section id="rsvp" className="mt-10 rounded-2xl border border-line bg-surface/50 p-5 sm:p-6">
      <p className="eyebrow">{t("eyebrow")}</p>

      {confirmed ? (
        <p className="mt-2 font-medium text-paper">{confirmationLine(confirmed, t)}</p>
      ) : (
        <p className="mt-2 text-paper/90">{framesWaitlist ? t("introFull") : t("intro")}</p>
      )}

      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        {/* Status — the bold choice, tinted with the host's accent when selected. */}
        <fieldset>
          <legend className="sr-only">{t("yourReply")}</legend>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("yourReply")}>
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
                  {s === "going" && framesWaitlist ? t("joinWaitlist") : t(STATUS_LABEL_KEYS[s])}
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Name — the only required field. */}
        <div>
          <label htmlFor="rsvp-name" className="block text-sm font-medium text-paper">
            {t("nameLabel")}
          </label>
          <input
            id="rsvp-name"
            name="display_name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder={t("namePlaceholder")}
            className="mt-1.5 h-11 w-full rounded-xl border border-line bg-ink/40 px-3.5 text-paper placeholder:text-muted/60 focus-visible:border-iris"
          />
        </div>

        {/* Plus-ones — only when the host allows them. */}
        {allowPlusOnes && status === "going" && maxPlusOnes > 0 && (
          <div>
            <label htmlFor="rsvp-plus-ones" className="block text-sm font-medium text-paper">
              {t("plusOnesLabel")}{" "}
              <span className="text-muted">{t("plusOnesUpTo", { count: maxPlusOnes })}</span>
            </label>
            <select
              id="rsvp-plus-ones"
              value={plusOnes}
              onChange={(e) => setPlusOnes(Number(e.target.value))}
              className="mt-1.5 h-11 w-full rounded-xl border border-line bg-ink/40 px-3 text-paper focus-visible:border-iris"
            >
              {Array.from({ length: maxPlusOnes + 1 }, (_, n) => (
                <option key={n} value={n}>
                  {n === 0 ? t("plusOnesJustMe") : `+${n}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Contact — optional; host-visible metadata only, never an identity key (D1). */}
        <div>
          <label htmlFor="rsvp-contact" className="block text-sm font-medium text-paper">
            {t("contactLabel")} <span className="text-muted">{t("contactOptional")}</span>
          </label>
          <input
            id="rsvp-contact"
            name="contact"
            type="text"
            autoComplete="off"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={200}
            placeholder={t("contactPlaceholder")}
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
function confirmationLine(result: RsvpResult, t: (key: string) => string): string {
  if (result.waitlisted || result.status === "waitlisted") {
    return t("confirmWaitlisted");
  }
  switch (result.status) {
    case "going":
      return t("confirmGoing");
    case "maybe":
      return t("confirmMaybe");
    case "not_going":
      return t("confirmNotGoing");
    default:
      return t("confirmDefault");
  }
}
