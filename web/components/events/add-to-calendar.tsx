"use client";

import {
  buildGoogleCalendarUrl,
  buildIcs,
  eventCalendarSource,
  icsFilename,
} from "@/lib/events/calendar";
import type { EventView } from "@/lib/events/view";

/**
 * "Add to calendar" (task 2.6) — lets a guest drop the event onto their own calendar
 * with no account and no contact (不依赖 contact). Two paths, both derived purely from
 * the façade this page already holds:
 *   - Google Calendar: a TEMPLATE deep link (a plain anchor → SSR-stable, opens in a
 *     new tab);
 *   - Apple / Outlook (and anything that reads .ics): a downloaded calendar file built
 *     and handed over at click time via a Blob — nothing touches the network.
 *
 * Tiering is the data layer's job, inherited here for free: the calendar LOCATION is the
 * full address only when the payload is unlocked, otherwise the city. We render nothing
 * for a date-TBD/undated event — there is no instant to add.
 */
export function AddToCalendar({ event }: { event: EventView }) {
  const source = eventCalendarSource(event);
  if (!source) return null;

  const googleUrl = buildGoogleCalendarUrl(source);

  function downloadIcs() {
    const src = eventCalendarSource(event);
    if (!src) return;
    const ics = buildIcs(src, new Date());
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = icsFilename(event.title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const itemClass =
    "inline-flex h-9 items-center justify-center rounded-lg border border-line px-3.5 text-sm font-medium text-paper transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris";

  return (
    <div className="mt-6 flex flex-wrap items-center gap-2.5">
      <span className="text-sm text-muted">Add to calendar</span>
      <a href={googleUrl} target="_blank" rel="noopener noreferrer" className={itemClass}>
        Google
      </a>
      <button type="button" onClick={downloadIcs} className={itemClass}>
        Apple / Outlook
      </button>
    </div>
  );
}
