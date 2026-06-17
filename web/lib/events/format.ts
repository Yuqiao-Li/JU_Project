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
