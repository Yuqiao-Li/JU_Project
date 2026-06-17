/**
 * Shared event date formatting (task 2.3). Display-only — the security-bearing
 * fields (full address, guest list) are gated in the DB, never here.
 *
 * All times are formatted in zh-CN in the event time zone (Asia/Shanghai), so a
 * stored instant reads back as the same Beijing wall-clock time for every viewer
 * regardless of their device tz (see ./timezone).
 */
import { EVENT_TIME_ZONE } from "./timezone";

// TODO(i18n): "Date TBD" is a lib-level display string; localize it in the
// server-side-messages pass (it currently shows in English on date-TBD events).
const TBD = "Date TBD";

const WHEN_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: EVENT_TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const DAY_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: EVENT_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  weekday: "short",
});

const END_TIME_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: EVENT_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Stable per-day key in the event tz, to decide whether an end falls on another day.
const DAY_KEY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: EVENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "When" line for a card: a date-TBD event reads "Date TBD"; an undated one too. */
export function formatEventWhen(startsAt: string | null, dateTbd: boolean): string {
  if (dateTbd || !startsAt) return TBD;
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return TBD;
  return WHEN_FMT.format(ms);
}

/** A shorter day-only label (used where the time isn't worth the noise). */
export function formatEventDay(startsAt: string | null, dateTbd: boolean): string {
  if (dateTbd || !startsAt) return TBD;
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return TBD;
  return DAY_FMT.format(ms);
}

/**
 * A single date-poll option label, e.g. "6月20日周六 19:30 – 22:00". When the end
 * falls on a different Beijing day, its date is included so multi-day candidates
 * read unambiguously (e.g. "… 22:00 – 6月21日周日 02:00").
 */
export function formatOptionWhen(startsAt: string, endsAt: string | null): string {
  const start = Date.parse(startsAt);
  if (Number.isNaN(start)) return TBD;
  const base = WHEN_FMT.format(start);
  if (!endsAt) return base;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return base;
  const sameDay = DAY_KEY_FMT.format(start) === DAY_KEY_FMT.format(end);
  const endLabel = sameDay ? END_TIME_FMT.format(end) : WHEN_FMT.format(end);
  return `${base} – ${endLabel}`;
}
