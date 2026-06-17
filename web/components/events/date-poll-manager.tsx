"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import {
  addDateOption,
  finalizeDate,
  removeDateOption,
  type DatePollState,
} from "@/app/dashboard/events/[id]/date-actions";
import { formatOptionWhen } from "@/lib/events/format";

/**
 * Host date-poll manager (task 5.1) — add/remove candidate dates and lock one in.
 *
 * The host-side companion to the public DatePoll: it lists each candidate with its live
 * vote count, lets the host add or remove candidates, and "Lock in" finalizes one
 * (finalize_date writes events.starts_at and KEEPS the votes, 保留投票记录). Every action
 * is a HOST-ONLY DB RPC routed through the host's own session — this UI is just the
 * affordance; the database is the gate. Shown on the edit page for a date-TBD event;
 * once a date is locked in the event leaves TBD and this collapses to a short note.
 */

const INITIAL: DatePollState = { status: "idle" };

export interface DatePollOptionView {
  id: string;
  starts_at: string;
  ends_at: string | null;
  votes: number;
}

export function DatePollManager({
  eventId,
  dateTbd,
  options,
}: {
  eventId: string;
  /** events.date_tbd — false once a date is locked in. */
  dateTbd: boolean;
  options: DatePollOptionView[];
}) {
  const t = useTranslations("feed");
  const [addState, addAction, adding] = useActionState(addDateOption, INITIAL);

  return (
    <section className="rounded-2xl border border-line bg-surface/40 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <p className="eyebrow">{t("datePoll")}</p>
        {!dateTbd && (
          <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">{t("dateLockedIn")}</span>
        )}
      </div>
      <p className="mt-2 text-sm text-muted">
        {dateTbd ? t("datePollHintTbd") : t("datePollHintLocked")}
      </p>

      {options.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t("noDatesYet")}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {options.map((o) => (
            <DateOptionRow key={o.id} eventId={eventId} option={o} dateTbd={dateTbd} />
          ))}
        </ul>
      )}

      {/* Add a candidate */}
      <form action={addAction} className="mt-5 border-t border-line/60 pt-5">
        <input type="hidden" name="event_id" value={eventId} />
        <p className="text-sm font-medium text-paper">{t("addDate")}</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="poll-starts" className="text-xs text-muted">
              {t("starts")}
            </label>
            <input
              id="poll-starts"
              name="starts_at"
              type="datetime-local"
              required
              className="h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-paper focus:border-iris focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="poll-ends" className="text-xs text-muted">
              {t("ends")} <span className="text-muted/60">{t("optional")}</span>
            </label>
            <input
              id="poll-ends"
              name="ends_at"
              type="datetime-local"
              className="h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-paper focus:border-iris focus:outline-none"
            />
          </div>
        </div>
        {addState.status === "error" && (
          <p role="alert" className="mt-2 text-sm text-coral">
            {addState.message}
          </p>
        )}
        <button
          type="submit"
          disabled={adding}
          aria-busy={adding}
          className="mt-3 inline-flex h-10 items-center justify-center rounded-xl border border-line px-4 text-sm font-semibold text-paper transition hover:bg-surface-2 disabled:opacity-60"
        >
          {adding ? t("adding") : t("addDateButton")}
        </button>
      </form>
    </section>
  );
}

/** One candidate row: the date, its tally, and the host's lock-in / remove controls. */
function DateOptionRow({
  eventId,
  option,
  dateTbd,
}: {
  eventId: string;
  option: DatePollOptionView;
  dateTbd: boolean;
}) {
  const t = useTranslations("feed");
  const [finalizeState, finalizeActionFn, finalizing] = useActionState(finalizeDate, INITIAL);
  const [removeState, removeActionFn, removing] = useActionState(removeDateOption, INITIAL);
  const error = finalizeState.status === "error" ? finalizeState.message : removeState.status === "error" ? removeState.message : null;

  return (
    <li className="rounded-xl border border-line bg-surface/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-paper">{formatOptionWhen(option.starts_at, option.ends_at)}</p>
          <p className="text-sm text-muted">
            {t("voteCount", { count: option.votes })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dateTbd && (
            <form action={finalizeActionFn}>
              <input type="hidden" name="event_id" value={eventId} />
              <input type="hidden" name="option_id" value={option.id} />
              <button
                type="submit"
                disabled={finalizing}
                aria-busy={finalizing}
                className="inline-flex h-9 items-center justify-center rounded-lg bg-coral px-3 text-sm font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
              >
                {finalizing ? t("locking") : t("lockIn")}
              </button>
            </form>
          )}
          <form action={removeActionFn}>
            <input type="hidden" name="event_id" value={eventId} />
            <input type="hidden" name="option_id" value={option.id} />
            <button
              type="submit"
              disabled={removing}
              aria-busy={removing}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-line px-3 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-paper disabled:opacity-60"
            >
              {removing ? t("removing") : t("remove")}
            </button>
          </form>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-coral">
          {error}
        </p>
      )}
    </li>
  );
}
