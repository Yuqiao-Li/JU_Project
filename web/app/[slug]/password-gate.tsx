"use client";

import { useState } from "react";

import { EventView } from "./event-view";
import type { EventView as EventViewData } from "@/lib/events/view";

/**
 * Password gate (task 2.4a) for a password-protected event.
 *
 * When `get_event_by_slug` returns the MINIMAL locked façade (title/cover/description
 * + `locked: true`), the SSR page renders this instead of the full event. The
 * security boundary is the database: a locked payload carries NO second-tier field, so
 * there is literally nothing here to leak — the address/guest list never reached the
 * client (SCHEMA gate ②).
 *
 * On submit we POST the candidate to `/api/events/[slug]/password`, which rate-limits
 * the attempt (per IP+event) and bcrypt-verifies via the trusted role BEFORE doing any
 * work (D7amend — blunts brute force AND bcrypt-DoS). On success that endpoint returns
 * the now-unlocked façade (still first-tier only — a correct password reveals the
 * poster, not the address; the address needs an RSVP token), which we render in place.
 * The password travels only in the POST body, never a URL.
 *
 * The persistent short-lived signed credential (so a reload/poll skips re-hashing) is
 * task 2.5; here a correct password reveals the event for this view.
 */
export function PasswordGate({
  slug,
  title,
  cover,
  description,
}: {
  slug: string;
  title: string;
  cover: string | null;
  description: string | null;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<EventViewData | null>(null);

  if (unlocked) return <EventView event={unlocked} />;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.status === 429) {
        setError("Too many tries. Wait a moment and try again.");
        return;
      }

      const data: unknown = await res.json().catch(() => null);
      const ok =
        !!data && typeof data === "object" && (data as { ok?: unknown }).ok === true;

      if (ok) {
        const event = (data as { event?: EventViewData | null }).event ?? null;
        if (event) {
          setUnlocked(event);
        } else {
          // Verified but the façade didn't come back — recover with a fresh load.
          window.location.reload();
        }
        return;
      }

      setError("That password didn’t match. Try again.");
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const surface = cover
    ? { backgroundImage: `url(${JSON.stringify(cover)})` }
    : undefined;

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-14">
      <div className="overflow-hidden rounded-3xl border border-line bg-surface">
        <div
          className="relative flex aspect-[16/9] items-end bg-surface-2 bg-cover bg-center"
          style={surface}
        >
          <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink/85 to-transparent" />
        </div>

        <div className="p-6 sm:p-7">
          <p className="eyebrow">Private event</p>
          <h1 className="mt-2 text-balance font-display text-2xl font-extrabold text-paper">{title}</h1>
          {description && <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>}

          <form onSubmit={onSubmit} className="mt-5 space-y-3">
            <label htmlFor="event-password" className="block text-sm font-medium text-paper">
              This event is password protected
            </label>
            <input
              id="event-password"
              name="password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter the password"
              aria-invalid={error ? true : undefined}
              className="h-11 w-full rounded-xl border border-line bg-ink/40 px-3.5 text-paper placeholder:text-muted/60 focus-visible:border-iris"
            />
            {error && (
              <p role="alert" className="text-sm text-coral">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || !password}
              aria-busy={busy}
              className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
            >
              {busy ? "Checking…" : "Unlock"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
