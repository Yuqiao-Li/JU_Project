"use client";

import { useLocale } from "next-intl";
import { useId } from "react";

import {
  COMMENT_OPTIONS,
  END_TIME_OPTIONS,
  WHEN_OPTIONS,
  buildLocalRangeEndScript,
  buildLocalTimeScript,
  formatInUtc,
  formatLocal,
  localDayKey,
} from "@/lib/events/when-format";

import { InlineScript } from "./inline-script";

/**
 * Viewer-local date/time display (Round-2 §7.4 DISPLAY path).
 *
 * Every "when" renders in the VIEWER's browser-local time zone, in their next-intl locale,
 * with a short zone label — never the host's or the server's. The hydration contract (from
 * the Next.js "preventing flash before hydration" guide):
 *
 *   - SERVER render → a deterministic UTC fallback (`formatInUtc`), since the server can't
 *     know the viewer's tz.
 *   - Soft `<Link>` nav → the client render formats in the browser directly (`formatLocal`);
 *     the inline script is inert (`text/plain`).
 *   - Hard nav / refresh → the inline script rewrites the `<time>` to the local value during
 *     HTML parsing, before paint.
 *
 * `suppressHydrationWarning` is NON-NEGOTIABLE on every `<time>` here: it tells React to
 * accept the DOM (which the script corrected) over the RSC payload, so the script's
 * correction survives hydration. Each `<time>` gets its own `useId`.
 */

/** A single viewer-local timestamp. An undated/invalid value renders `tbdLabel` (plain text). */
export function LocalWhen({
  iso,
  options = WHEN_OPTIONS,
  tbdLabel,
}: {
  iso: string | null | undefined;
  options?: Intl.DateTimeFormatOptions;
  tbdLabel: string;
}) {
  const locale = useLocale();
  const id = useId();

  // Undated or unparseable → no <time>, just the localized "Date TBD".
  if (!iso || formatInUtc(iso, locale, options) === "") return <>{tbdLabel}</>;

  return (
    <>
      <time id={id} dateTime={iso} suppressHydrationWarning>
        {typeof window === "undefined"
          ? formatInUtc(iso, locale, options)
          : formatLocal(iso, locale, options)}
      </time>
      <InlineScript html={buildLocalTimeScript(id, iso, locale, options)} />
    </>
  );
}

/**
 * A viewer-local start→end range (replaces the old `formatOptionWhen`). With no end it is a
 * single `LocalWhen`. With an end: the start in full, a separator, then the end — TIME-ONLY
 * when it shares the start's LOCAL day, full date+time otherwise. That same-local-day call
 * is tz-dependent, so it is resolved client-side (the SSR fallback may show both ends full
 * in UTC; the client collapses the end on a same-local-day range). Hydration-safe via
 * `suppressHydrationWarning` on each `<time>`.
 */
export function LocalWhenRange({
  startsAt,
  endsAt,
  options = WHEN_OPTIONS,
  endOptions = END_TIME_OPTIONS,
}: {
  startsAt: string | null | undefined;
  endsAt: string | null | undefined;
  options?: Intl.DateTimeFormatOptions;
  endOptions?: Intl.DateTimeFormatOptions;
}) {
  const locale = useLocale();
  const endId = useId();

  // No end (or an unparseable end) → just the start.
  if (!endsAt || formatInUtc(endsAt, locale, options) === "") {
    return <LocalWhen iso={startsAt ?? null} options={options} tbdLabel="" />;
  }
  // No valid start → fall back to the end alone (degenerate, but never an Invalid Date).
  if (!startsAt || formatInUtc(startsAt, locale, options) === "") {
    return <LocalWhen iso={endsAt} options={options} tbdLabel="" />;
  }

  // SSR fallback: decide same-day in UTC (deterministic). The client script re-decides in
  // the viewer's local zone and rewrites the end accordingly.
  const ssrSameDay =
    formatInUtcDayKey(startsAt) !== "" && formatInUtcDayKey(startsAt) === formatInUtcDayKey(endsAt);
  const ssrEndOpts = ssrSameDay ? endOptions : options;
  const clientSameDay = localDayKey(startsAt) !== "" && localDayKey(startsAt) === localDayKey(endsAt);
  const clientEndOpts = clientSameDay ? endOptions : options;

  return (
    <>
      <LocalWhen iso={startsAt} options={options} tbdLabel="" />
      {" – "}
      <time id={endId} dateTime={endsAt} suppressHydrationWarning>
        {typeof window === "undefined"
          ? formatInUtc(endsAt, locale, ssrEndOpts)
          : formatLocal(endsAt, locale, clientEndOpts)}
      </time>
      <InlineScript
        html={buildLocalRangeEndScript(endId, startsAt, endsAt, locale, options, endOptions)}
      />
    </>
  );
}

/** A comment's `<time dateTime>`, in the viewer's local zone + locale (COMMENT_OPTIONS). */
export function LocalCommentTime({ iso }: { iso: string }) {
  return <LocalWhen iso={iso} options={COMMENT_OPTIONS} tbdLabel="" />;
}

/** UTC `YYYY-MM-DD` day key, mirroring `localDayKey` but pinned to UTC for the SSR decision. */
function formatInUtcDayKey(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}
