/**
 * Shared event date formatting (task 2.3). Display-only — the security-bearing
 * fields (full address, guest list) are gated in the DB, never here.
 */

const WHEN_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const DAY_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "When" line for a card: a date-TBD event reads "Date TBD"; an undated one too. */
export function formatEventWhen(startsAt: string | null, dateTbd: boolean): string {
  if (dateTbd || !startsAt) return "Date TBD";
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return "Date TBD";
  return WHEN_FMT.format(new Date(ms));
}

/** A shorter day-only label (used where the time isn't worth the noise). */
export function formatEventDay(startsAt: string | null, dateTbd: boolean): string {
  if (dateTbd || !startsAt) return "Date TBD";
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return "Date TBD";
  return DAY_FMT.format(new Date(ms));
}

const END_TIME_FMT = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** A single date-poll option label: "Sat, Jan 1, 6:00 PM" (+ " – 9:00 PM" when ended). */
export function formatOptionWhen(startsAt: string, endsAt: string | null): string {
  const start = Date.parse(startsAt);
  if (Number.isNaN(start)) return "Date TBD";
  const base = WHEN_FMT.format(new Date(start));
  if (!endsAt) return base;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return base;
  return `${base} – ${END_TIME_FMT.format(new Date(end))}`;
}
