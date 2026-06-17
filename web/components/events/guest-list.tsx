import {
  groupGuestList,
  guestHeadcount,
  type GuestListEntry,
} from "@/lib/events/guest-list";

/**
 * "Who's coming" — the public guest list (task 3.1).
 *
 * SECURITY-BEARING VISIBILITY (TEST-SPEC §3.1; task 禁止: "未解锁不可见"). This renders
 * ONLY for an unlocked viewer, and even then only data the RPC already desensitized:
 * Going/Maybe names with their +1 count. The data layer is the boundary — Can't-Go,
 * contact, guest_id and tokens never reach this component (get_guest_list omits them,
 * and parseGuestList drops anything off-contract), so there is nothing here to hide
 * with CSS. When locked we render NOTHING (return null), not a hidden block.
 *
 * COUNT RULE (D7②, independent of the list). A host can show the names but hide the
 * headcount: when `showCounts` is false we render no number anywhere — just the names —
 * mirroring how get_event_by_slug omits going_count entirely (TEST-SPEC §3.1: hidden ⇒
 * 人数不显示). When shown, the per-group number counts heads INCLUDING +1s, matching the
 * event's going_count accounting.
 *
 * Presentational only: all polling/unlock state lives in the client shell (EventClient),
 * which re-fetches via the tiered poll endpoint — never a realtime subscription or a
 * direct table read (D4). New arrivals fade in on the next poll (reduced-motion honored
 * globally).
 */
export function GuestList({
  guests,
  unlocked,
  hidden,
  showCounts,
  accent,
}: {
  guests: GuestListEntry[];
  /** The viewer's unlock state — false ⇒ the list isn't theirs to see (render nothing). */
  unlocked: boolean;
  /** hide_guest_list === true — the host suppressed the list; render no section at all. */
  hidden: boolean;
  /** hide_guest_count === false — gate every numeric headcount on this (D7②). */
  showCounts: boolean;
  /** Host accent (events.theme.color) for the +1 badge tint. */
  accent: string;
}) {
  // Locked viewers never see the list — and the data layer never sent it. The host can
  // also hide the list outright (hide_guest_list); the RPC returns [] then, so we render
  // no section rather than a misleading "no replies yet". Either way: nothing to render.
  if (!unlocked || hidden) return null;

  const { going, maybe } = groupGuestList(guests);

  return (
    <section className="mt-10">
      <h2 className="eyebrow">Who&rsquo;s coming</h2>

      {going.length === 0 && maybe.length === 0 ? (
        <p className="mt-2 text-muted">No replies yet — be the first to RSVP.</p>
      ) : (
        <div className="mt-3 space-y-6">
          <Group
            label="Going"
            entries={going}
            showCounts={showCounts}
            accent={accent}
          />
          <Group
            label="Maybe"
            entries={maybe}
            showCounts={showCounts}
            accent={accent}
          />
        </div>
      )}
    </section>
  );
}

/** One status group (Going / Maybe). Renders nothing when empty so we never show a
 *  bare "Maybe" header with no one under it. */
function Group({
  label,
  entries,
  showCounts,
  accent,
}: {
  label: string;
  entries: GuestListEntry[];
  showCounts: boolean;
  accent: string;
}) {
  if (entries.length === 0) return null;

  return (
    <div>
      <h3 className="flex items-baseline gap-2 text-sm font-semibold text-paper">
        {label}
        {showCounts && (
          <span className="text-sm font-normal text-muted">{guestHeadcount(entries)}</span>
        )}
      </h3>
      <ul className="mt-2 flex flex-wrap gap-2">
        {entries.map((g, i) => (
          <li
            key={`${g.display_name}-${i}`}
            className="guest-enter inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/60 px-3 py-1.5 text-sm text-paper"
          >
            <span className="truncate max-w-[14rem]">{g.display_name}</span>
            {g.plus_ones > 0 && (
              <span
                className="rounded-full px-1.5 py-0.5 text-xs font-semibold text-ink"
                style={{ backgroundColor: accent }}
              >
                +{g.plus_ones}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
