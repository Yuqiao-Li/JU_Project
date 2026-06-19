"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { lockEvent } from "../actions";

/**
 * Host "lock event" control (round-4) with a TWO-STEP confirm — never a bare
 * window.confirm. Locking is irreversible, opens both sides' WeChat, and stops new
 * RSVPs, so the first click reveals an inline panel spelling that out; only the
 * explicit "confirm lock" button calls the server action. Authorization is the RPC's
 * job (auth.uid() == host_id); this is just the affordance.
 */
export function LockEventButton({ eventId }: { eventId: string }) {
  const t = useTranslations("hostEvent");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const btn =
    "inline-flex h-9 items-center justify-center rounded-lg border border-line px-3 text-sm font-medium text-paper transition hover:bg-surface-2 disabled:opacity-60";

  function lock() {
    setError(null);
    startTransition(async () => {
      const res = await lockEvent(eventId);
      if (!res.ok) setError(t("lockFailed"));
      else {
        setConfirming(false);
        router.refresh();
      }
    });
  }

  if (!confirming) {
    return (
      <button type="button" className={btn} disabled={pending} onClick={() => setConfirming(true)}>
        {t("lockEvent")}
      </button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-iris/40 bg-iris/10 p-4">
      <p className="font-semibold text-paper">{t("lockConfirmHeading")}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-paper/90">
        <li>{t("lockConfirmIrreversible")}</li>
        <li>{t("lockConfirmReveal")}</li>
        <li>{t("lockConfirmStops")}</li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex h-9 items-center justify-center rounded-lg bg-coral px-4 text-sm font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
          disabled={pending}
          onClick={lock}
        >
          {t("lockConfirm")}
        </button>
        <button
          type="button"
          className={btn}
          disabled={pending}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          {t("lockCancel")}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
    </div>
  );
}
