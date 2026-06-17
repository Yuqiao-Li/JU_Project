/**
 * Time-zone policy (launch): events are entered AND displayed in China Standard
 * Time (Asia/Shanghai, a fixed +08:00 with no DST). The host's datetime-local
 * input is read as Beijing wall-clock time, persisted as the correct UTC instant,
 * and shown back in Beijing time to EVERY viewer regardless of their device tz —
 * so "19:30" always means 19:30 北京时间.
 *
 * Per-event time zones (events abroad) are a future enhancement and would need an
 * events.time_zone column; until then this single zone is the source of truth.
 */
export const EVENT_TIME_ZONE = "Asia/Shanghai";
const EVENT_UTC_OFFSET = "+08:00";

/** datetime-local "YYYY-MM-DDTHH:mm" (Beijing wall-clock) → UTC ISO instant, or null. */
export function localInputToISO(naive: string): string | null {
  const v = naive.trim();
  if (!v) return null;
  const withSeconds = /T\d{2}:\d{2}$/.test(v) ? `${v}:00` : v;
  const d = new Date(`${withSeconds}${EVENT_UTC_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** UTC ISO instant → "YYYY-MM-DDTHH:mm" in Beijing time, for a datetime-local input. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
