"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import { promoteGuest, type PromoteState } from "./actions";

/**
 * Manual promote control (task 3.2) — the host's per-row "move a waitlisted guest to
 * going" button. A tiny form posting the rsvp/event ids to the promoteGuest server
 * action; the action runs the host-only, capacity-respecting RPC. A capacity refusal
 * comes back as an inline message rather than silently doing nothing.
 */

const INITIAL: PromoteState = { status: "idle" };

export function PromoteButton({ rsvpId, eventId }: { rsvpId: string; eventId: string }) {
  const t = useTranslations("hostEvent");
  const [state, formAction, pending] = useActionState(promoteGuest, INITIAL);

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="rsvp_id" value={rsvpId} />
      <input type="hidden" name="event_id" value={eventId} />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="inline-flex h-9 items-center justify-center rounded-lg border border-line px-3 text-sm font-semibold text-paper transition hover:bg-surface-2 disabled:opacity-60"
      >
        {pending ? t("moving") : t("moveToGoing")}
      </button>
      {state.status === "error" && state.message && (
        <p role="alert" className="text-xs text-coral">
          {state.message}
        </p>
      )}
    </form>
  );
}
