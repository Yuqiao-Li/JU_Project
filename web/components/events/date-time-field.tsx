"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  addMonths,
  buildMonthGrid,
  clampParts,
  daysInMonth,
  DEFAULT_TIME,
  displayToNaive,
  formatMaskedInput,
  joinNaive,
  naiveToDisplay,
  splitNaive,
  type DateTimeParts,
} from "@/lib/events/datetime-field";
import { isoToLocalInput, localInputToISO } from "@/lib/events/timezone";

/**
 * Custom date+time field — drop-in replacement for `<input type="datetime-local">`.
 *
 * Why: the native input renders its format in the BROWSER's language, so a
 * Chinese-browser host saw a mixed "yyyy/mm/日". Here the typed/displayed format
 * is LOCKED to `yyyy/mm/dd HH:mm` (24h) for everyone; only the calendar chrome
 * (month caption, weekday headers, day labels) localises via Intl.
 *
 * The seam: we submit a hidden `<input name={name}>` whose value is a UTC ISO
 * instant (or ""), so `schema.ts` just validates an ISO — the browser-local →
 * UTC conversion happens HERE (the host's tz is only known client-side). The
 * naive `"YYYY-MM-DDTHH:mm"` display/edit math still flows through the pure
 * string/int helpers in `lib/events/datetime-field` (never a `Date`); only the
 * naive↔ISO boundary uses `localInputToISO` / `isoToLocalInput`.
 *
 * Hydration-safe: the hidden ISO is seeded from `defaultIso` and is tz-INDEPENDENT,
 * so SSR and the client's first render agree (no mismatch on the submitted value).
 * The naive DISPLAY is tz-dependent, so it starts EMPTY and is seeded only after
 * mount via `isoToLocalInput(defaultIso)` (a brief empty→filled on an edit form is
 * the cost of avoiding a server-tz hydration mismatch; new events have no defaultIso,
 * so no flash). The fallback month, Today button, and today-marker likewise wait for
 * mount (the `today` state is null until then). No `new Date()` in the render path.
 */

type Props = {
  name: string;
  id?: string;
  /** The stored UTC instant to edit (null/undefined for a new event). */
  defaultIso?: string | null;
  disabled?: boolean;
  className?: string;
};

/** A stable month to render before mount / when the value is empty (no `Date` at module load). */
const FALLBACK_MONTH = { y: 2026, mo: 1 };

/** Normalise an arbitrary incoming value to a clean naive string (or "") — string-only. */
function normalize(value: string | undefined): string {
  if (!value) return "";
  const parts = splitNaive(value);
  if (!parts) return "";
  return joinNaive(clampParts(parts));
}

export function DateTimeField({ name, id, defaultIso, disabled = false, className = "" }: Props) {
  const t = useTranslations("eventForm");
  const locale = useLocale();

  // The naive wall-clock value driving the display. Starts EMPTY (the naive form
  // of `defaultIso` is tz-dependent, so it's seeded post-mount) and is the single
  // source of truth for the visible field once the host interacts.
  const [value, setValue] = useState<string>("");
  // What gets SUBMITTED: a UTC ISO instant. Seeded from `defaultIso` (tz-INDEPENDENT,
  // so SSR === first client render → no hydration mismatch on the hidden input). On
  // every user edit we recompute it from the (browser-local) naive value below, so an
  // untouched edit form re-submits the original instant unchanged.
  const [iso, setIso] = useState<string>(defaultIso ?? "");
  // What's shown in the masked text input. Kept loosely coupled so a partial
  // value (mid-typing) can display without forcing a (still-empty) `value`.
  const [text, setText] = useState<string>("");

  const [open, setOpen] = useState(false);
  // "Today" is device-clock-derived, so it must wait until after mount to stay
  // hydration-safe (no `new Date()` in the render path). `null` until mount; we
  // gate the Today button + today-marker on it. Held as STATE (not a ref) so it's
  // never read during render before it's set, and so the marker re-renders.
  const [today, setToday] = useState<{ y: number; mo: number; d: number } | null>(null);
  // The month the calendar is currently showing. Starts at the fallback month and
  // is pointed at the seeded value / today post-mount (no tz-dependent value at SSR).
  const [view, setView] = useState<{ y: number; mo: number }>(FALLBACK_MONTH);
  // Roving-focus day within the visible grid (drives arrow-key navigation).
  const [focusDay, setFocusDay] = useState<number>(1);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const popoverId = `${id ?? name ?? reactId}-popover`;

  // Post-mount, client-only seeding. This is the one legitimate place to sync
  // client-only state in an effect (it can't run on the server without breaking
  // hydration); the lint's set-state-in-effect rule is suppressed here.
  // We (a) read the device clock for the Today affordance, and (b) seed the naive
  // DISPLAY from `defaultIso` — `isoToLocalInput` is browser-local, so it can only
  // run here, not at SSR. The hidden ISO is already correct from initial state.
  useEffect(() => {
    const now = new Date();
    const t = { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
    setToday(t); // eslint-disable-line react-hooks/set-state-in-effect
    const naive = normalize(isoToLocalInput(defaultIso ?? null));
    if (naive) {
      // An existing instant: fill the display and point the calendar at it.
      setValue(naive);
      setText(naiveToDisplay(naive));
      const p = splitNaive(naive);
      if (p) {
        setView({ y: p.y, mo: p.mo });
        setFocusDay(p.d);
      }
    } else {
      // Empty field: point the calendar at the current month.
      setView({ y: t.y, mo: t.mo });
      setFocusDay(t.d);
    }
  }, [defaultIso]);

  const selected = useMemo(() => splitNaive(value), [value]);

  /** Commit a fully-formed parts object to the value, text box, and submitted ISO. */
  const commitParts = useCallback((parts: DateTimeParts) => {
    const naive = joinNaive(clampParts(parts));
    setValue(naive);
    setText(naiveToDisplay(naive));
    // Browser-local → UTC for the submitted instant (this runs only in handlers).
    setIso(localInputToISO(naive) ?? "");
  }, []);

  /** Set the date (keeping any existing time, else DEFAULT_TIME), e.g. on day-click. */
  const pickDate = useCallback(
    (y: number, mo: number, d: number) => {
      // Keep the existing time, else stamp DEFAULT_TIME (string-sliced, no Date).
      const h = selected ? selected.h : Number.parseInt(DEFAULT_TIME.slice(0, 2), 10);
      const mi = selected ? selected.mi : Number.parseInt(DEFAULT_TIME.slice(3, 5), 10);
      commitParts({ y, mo, d, h, mi });
    },
    [selected, commitParts],
  );

  /** Set just the time, keeping the existing (or current) date. */
  const setTime = useCallback(
    (which: "h" | "mi", rawDigits: string) => {
      const base: DateTimeParts =
        selected ??
        (today
          ? { y: today.y, mo: today.mo, d: today.d, h: 19, mi: 30 }
          : { y: view.y, mo: view.mo, d: 1, h: 19, mi: 30 });
      const n = Number.parseInt(rawDigits || "0", 10);
      const next: DateTimeParts = { ...base, [which]: Number.isNaN(n) ? 0 : n };
      commitParts(next);
    },
    [selected, today, view, commitParts],
  );

  // --- Outside-pointerdown + Escape close, with focus return to trigger. ---
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  // Toggle the popover. Opening syncs the view to the selected value (or today)
  // in the same event — not an effect — so no cascading-render lint, then a
  // focus effect moves focus into the grid once it's painted.
  const toggleOpen = useCallback(() => {
    setOpen((wasOpen) => {
      if (wasOpen) return false;
      if (selected) {
        setView({ y: selected.y, mo: selected.mo });
        setFocusDay(selected.d);
      } else if (today) {
        setView({ y: today.y, mo: today.mo });
        setFocusDay(today.d);
      }
      return true;
    });
  }, [selected, today]);

  // Move focus into the grid once the popover is open and painted.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>('[data-focusable="true"]')?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // --- i18n chrome: weekday headers + month caption + day labels via Intl. ---
  // Weekday names from a fixed reference week (2024-01-07 is a Sunday, UTC).
  const weekdayNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 7 + i))));
  }, [locale]);

  const monthCaption = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" });
    return fmt.format(new Date(Date.UTC(view.y, view.mo - 1, 1)));
  }, [locale, view]);

  const dayLabelFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }),
    [locale],
  );

  const grid = useMemo(() => buildMonthGrid(view.y, view.mo), [view]);

  const goMonth = useCallback((delta: number) => {
    setView((v) => {
      const next = addMonths(v.y, v.mo, delta);
      setFocusDay((d) => Math.min(d, daysInMonth(next.y, next.mo)));
      return next;
    });
  }, []);

  // --- Roving keyboard navigation over the day grid. ---
  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const dim = daysInMonth(view.y, view.mo);
      let next = focusDay;
      switch (e.key) {
        case "ArrowLeft":
          next = focusDay - 1;
          break;
        case "ArrowRight":
          next = focusDay + 1;
          break;
        case "ArrowUp":
          next = focusDay - 7;
          break;
        case "ArrowDown":
          next = focusDay + 7;
          break;
        case "PageUp":
          goMonth(-1);
          e.preventDefault();
          return;
        case "PageDown":
          goMonth(1);
          e.preventDefault();
          return;
        case "Home":
          next = 1;
          break;
        case "End":
          next = dim;
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          pickDate(view.y, view.mo, focusDay);
          return;
        default:
          return;
      }
      e.preventDefault();
      if (next < 1) {
        const prev = addMonths(view.y, view.mo, -1);
        const prevDim = daysInMonth(prev.y, prev.mo);
        setView(prev);
        setFocusDay(prevDim + next);
      } else if (next > dim) {
        const fwd = addMonths(view.y, view.mo, 1);
        setView(fwd);
        setFocusDay(next - dim);
      } else {
        setFocusDay(next);
      }
    },
    [focusDay, view, goMonth, pickDate],
  );

  // Focus the roving day after arrow navigation changes the target.
  useEffect(() => {
    if (!open) return;
    const el = gridRef.current?.querySelector<HTMLButtonElement>('[data-focusable="true"]');
    if (el && el !== document.activeElement && gridRef.current?.contains(document.activeElement)) {
      el.focus();
    }
  }, [focusDay, view, open]);

  const onTextChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const masked = formatMaskedInput(e.target.value);
    setText(masked);
    const naive = displayToNaive(masked); // "" until the value is complete + valid
    setValue(naive);
    setIso(localInputToISO(naive) ?? ""); // browser-local → UTC, "" while incomplete
  }, []);

  const clear = useCallback(() => {
    setValue("");
    setText("");
    setIso("");
  }, []);

  const pickToday = useCallback(() => {
    if (!today) return;
    setView({ y: today.y, mo: today.mo });
    setFocusDay(today.d);
    pickDate(today.y, today.mo, today.d);
  }, [today, pickDate]);

  const timeH = selected ? String(selected.h).padStart(2, "0") : "";
  const timeMi = selected ? String(selected.mi).padStart(2, "0") : "";

  const wrapperClass = [
    "flex items-center rounded-xl border border-line bg-surface-2 px-4 text-paper transition",
    "focus-within:border-iris",
    disabled ? "opacity-50" : "",
    className?.includes("h-12") ? "" : "h-12",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={wrapperRef} className="relative">
      {/* The seam: a UTC ISO instant (browser-local → UTC, converted in handlers).
          `disabled` (dateTbd) keeps it out of the FormData, matching the old native
          input's behaviour of submitting no date when the field is off. */}
      <input type="hidden" name={name} value={iso} disabled={disabled} />

      <div className={wrapperClass}>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={text}
          onChange={onTextChange}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          placeholder="yyyy/mm/dd HH:mm"
          className="h-full w-full bg-transparent text-paper placeholder:text-muted/60 focus:outline-none disabled:cursor-not-allowed"
        />
        <button
          ref={triggerRef}
          type="button"
          onClick={toggleOpen}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={popoverId}
          aria-label={t("pickDate")}
          className="-mr-1 ml-2 grid size-8 shrink-0 place-items-center rounded-lg text-muted transition hover:text-paper disabled:cursor-not-allowed"
        >
          <svg viewBox="0 0 24 24" aria-hidden className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4.5" width="18" height="16" rx="2" />
            <path d="M3 9h18M8 2.5v4M16 2.5v4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {open && !disabled && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={t("calendarLabel")}
          className="guest-enter absolute left-0 top-[calc(100%+0.5rem)] z-20 w-[19rem] rounded-2xl border border-line bg-surface p-4 shadow-2xl"
        >
          {/* Month nav */}
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => goMonth(-1)}
              aria-label={t("prevMonth")}
              className="grid size-8 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-paper"
            >
              ‹
            </button>
            <span aria-live="polite" className="text-sm font-semibold text-paper">
              {monthCaption}
            </span>
            <button
              type="button"
              onClick={() => goMonth(1)}
              aria-label={t("nextMonth")}
              className="grid size-8 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-paper"
            >
              ›
            </button>
          </div>

          {/* Grid */}
          <div role="grid" aria-label={monthCaption} ref={gridRef} onKeyDown={onGridKeyDown}>
            <div role="row" className="mb-1 grid grid-cols-7">
              {weekdayNames.map((wd, i) => (
                <span key={i} role="columnheader" className="py-1 text-center text-xs text-muted">
                  {wd}
                </span>
              ))}
            </div>
            {Array.from({ length: 6 }, (_, week) => (
              <div role="row" key={week} className="grid grid-cols-7">
                {grid.slice(week * 7, week * 7 + 7).map((day, col) => {
                  if (day === null) {
                    return <span role="gridcell" key={col} aria-hidden className="size-9" />;
                  }
                  const isSelected =
                    !!selected && selected.y === view.y && selected.mo === view.mo && selected.d === day;
                  // `today` is null until mount, so the marker is absent on SSR /
                  // first client render — keeping hydration stable.
                  const isToday =
                    !!today && today.y === view.y && today.mo === view.mo && today.d === day;
                  const isFocusTarget = day === focusDay;
                  const label = dayLabelFmt.format(new Date(Date.UTC(view.y, view.mo - 1, day)));
                  return (
                    <div role="gridcell" key={col} aria-selected={isSelected}>
                      <button
                        type="button"
                        data-focusable={isFocusTarget ? "true" : undefined}
                        tabIndex={isFocusTarget ? 0 : -1}
                        onClick={() => pickDate(view.y, view.mo, day)}
                        aria-label={label}
                        aria-current={isToday ? "date" : undefined}
                        className={[
                          "grid size-9 place-items-center rounded-lg text-sm transition",
                          isSelected
                            ? "bg-coral font-semibold text-ink"
                            : "text-paper hover:bg-surface-2",
                          isToday && !isSelected ? "ring-1 ring-iris" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {day}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Time */}
          <div className="mt-3 flex items-center gap-2">
            <input
              inputMode="numeric"
              maxLength={2}
              value={timeH}
              onChange={(e) => setTime("h", e.target.value.replace(/\D/g, ""))}
              onBlur={(e) => {
                if (selected) setTime("h", e.target.value.replace(/\D/g, ""));
              }}
              aria-label={t("hourLabel")}
              placeholder="HH"
              className="h-10 w-14 rounded-lg border border-line bg-surface-2 text-center text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
            />
            <span aria-hidden className="text-muted">
              :
            </span>
            <input
              inputMode="numeric"
              maxLength={2}
              value={timeMi}
              onChange={(e) => setTime("mi", e.target.value.replace(/\D/g, ""))}
              onBlur={(e) => {
                if (selected) setTime("mi", e.target.value.replace(/\D/g, ""));
              }}
              aria-label={t("minuteLabel")}
              placeholder="mm"
              className="h-10 w-14 rounded-lg border border-line bg-surface-2 text-center text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
            />
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={pickToday}
                aria-label={t("today")}
                className="h-9 rounded-lg px-3 text-sm text-iris transition hover:bg-surface-2"
              >
                {t("today")}
              </button>
              <button
                type="button"
                onClick={clear}
                aria-label={t("clearDate")}
                className="h-9 rounded-lg px-3 text-sm text-muted transition hover:bg-surface-2 hover:text-paper"
              >
                {t("clearDate")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
