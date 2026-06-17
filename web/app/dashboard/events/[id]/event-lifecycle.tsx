"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { deleteEvent, setEventStatus } from "../actions";

/**
 * Host lifecycle controls (task 4 / audit H5-H8): publish / unpublish / cancel /
 * republish / delete. Authorization is RLS in the server actions; this is only the
 * affordance + confirm prompts. Destructive actions confirm first.
 */
export function EventLifecycle({ eventId, status }: { eventId: string; status: string }) {
  const t = useTranslations("hostEvent");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function changeStatus(next: "published" | "draft" | "cancelled") {
    setError(null);
    startTransition(async () => {
      const res = await setEventStatus(eventId, next);
      if (!res.ok) setError(t("actionFailed"));
      else router.refresh();
    });
  }

  function confirmAnd(message: string, action: () => void) {
    if (window.confirm(message)) action();
  }

  const btn =
    "inline-flex h-9 items-center justify-center rounded-lg border border-line px-3 text-sm font-medium text-paper transition hover:bg-surface-2 disabled:opacity-60";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status !== "published" && (
        <button type="button" className={btn} disabled={pending} onClick={() => changeStatus("published")}>
          {status === "cancelled" ? t("republish") : t("publish")}
        </button>
      )}
      {status === "published" && (
        <button
          type="button"
          className={btn}
          disabled={pending}
          onClick={() => confirmAnd(t("unpublishConfirm"), () => changeStatus("draft"))}
        >
          {t("unpublish")}
        </button>
      )}
      {status !== "cancelled" && (
        <button
          type="button"
          className={btn}
          disabled={pending}
          onClick={() => confirmAnd(t("cancelConfirm"), () => changeStatus("cancelled"))}
        >
          {t("cancelEvent")}
        </button>
      )}
      <button
        type="button"
        className={`${btn} border-transparent text-coral hover:bg-coral/10`}
        disabled={pending}
        onClick={() =>
          confirmAnd(t("deleteConfirm"), () =>
            startTransition(async () => {
              const res = await deleteEvent(eventId);
              // On success deleteEvent redirects; only an error path returns here.
              if (!res.ok) setError(t("actionFailed"));
            }),
          )
        }
      >
        {t("deleteEvent")}
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-coral">
          {error}
        </p>
      )}
    </div>
  );
}
