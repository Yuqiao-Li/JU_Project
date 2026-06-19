"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import {
  gatheringStatus,
  initialCardState,
  spotsNeeded,
  viewerStatus,
  type CardState,
  type GatheringStatus,
  type ViewerStatus,
} from "@/lib/events/card";
import type { RsvpRecord } from "@/lib/events/rsvp-storage";

/**
 * 局卡 (event-card) shared component (Step-10A task 2) — JU's cornerstone, role-aware,
 * multi-state digital ticket-stub. ONE component for host + guest, dashboard + manage +
 * detail + share (event-card.md). Exported here for tasks 4–6 to mount; it is NOT wired
 * into any page yet.
 *
 * TWO FACES (态3 deferred):
 *  - `art`      态1 正面: the shareable PNG (the `opengraph-image` route) shown as an <img>.
 *  - `personal` 态2 个人化: interactive DOM — your standing (留位中 / 已锁定席位) + 成局
 *               progress (已 N 人 / 缺 X 人 + 已成局) + an expand toggle that reveals the
 *               role-specific form via {@link children} (guest = edit RSVP, host = manage).
 *
 * INTERACTION (host/guest 同构, event-card.md): 态1 → tap → 态2 → tap again → expand form.
 * The face flip respects `prefers-reduced-motion`: the global CSS rule already zeroes the
 * transition, and we additionally drop the animation class entirely when the user asks
 * for reduced motion, so the swap is an instant cut rather than a (CSS-neutralised) fade.
 *
 * ALL DECISIONS come from the pure helpers in lib/events/card.ts; this component only
 * renders them. ALL user-facing copy goes through next-intl `t()` under `eventCard`.
 *
 * FIRST-TIER DISCIPLINE: the art face is just an <img> at the public image route (no token),
 * and the personal face shows only counts (人数看板) + the viewer's OWN standing — never a
 * name list, address, or contact. The role form (children) owns any gated interaction.
 */

export interface EventCardProps {
  /** Page role — host owns the event; guest is anonymous (token-only). */
  mode: "host" | "guest";
  /** Slug — used to point the art <img> at this event's image route. */
  slug: string;
  /** Public façade numbers (first tier). */
  capacity: number | null | undefined;
  goingCount: number;
  /** Façade lock/unlock signals driving the viewer + gathering status. */
  isLocked: boolean | undefined;
  unlocked: boolean | undefined;
  /** The viewer's OWN cached RSVP (null = not yet RSVP'd); drives the opening face + standing. */
  record: RsvpRecord | null;
  /**
   * Force the opening face, overriding {@link initialCardState}. The 局详情 page passes
   * `"personal"` so the card lands directly on 态2 ("局卡的页面应该是直接实时呈现第二个
   * 状态") — pre-RSVP it shows 缺X人 + a 留位 prompt; post-RSVP the viewer's standing.
   * Omitted elsewhere ⇒ the pure {@link initialCardState} rule (share/save art first).
   */
  initialState?: CardState;
  /** The role-specific form revealed on the second tap (guest = edit RSVP, host = manage). */
  children?: React.ReactNode;
}

export function EventCard({
  mode,
  slug,
  capacity,
  goingCount,
  isLocked,
  unlocked,
  record,
  initialState,
  children,
}: EventCardProps) {
  const t = useTranslations("eventCard");

  const hasRsvp = record != null;
  const [state, setState] = useState<CardState>(
    () => initialState ?? initialCardState({ mode, hasRsvp }),
  );
  const [expanded, setExpanded] = useState(false);
  const animate = useAnimationEnabled();

  const needed = spotsNeeded(capacity, goingCount);
  const standing = viewerStatus({ record, unlocked, isLocked });
  const gathering = gatheringStatus({ capacity, goingCount, isLocked });

  // 态1 → tap → 态2 → tap → expand form (event-card.md interaction).
  function advance() {
    if (state === "art") {
      setState("personal");
      return;
    }
    setExpanded((v) => !v);
  }

  return (
    <div
      className={[
        "relative overflow-hidden rounded-2xl border border-paper/10 bg-ink/40",
        // Step 10B: visual — the real art/personal styling + flip transition live here.
        animate ? "transition-opacity duration-300" : "",
      ].join(" ")}
      data-card-state={state}
    >
      {state === "art" ? (
        <button
          type="button"
          onClick={advance}
          className="block w-full text-left"
          aria-label={t("flipToProgress")}
        >
          {/*
            态1 = the server-rendered PNG from the opengraph-image route (time + city + QR).
            Plain <img> (not next/image): the source is our own dynamic image route, and we
            want it to also be the OG share image — no remote-loader config, no layout shift.
            FIRST-TIER ONLY: the image route reads the event with no token.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/${encodeURIComponent(slug)}/opengraph-image`}
            alt={t("artAlt")}
            className="block w-full"
            width={1200}
            height={630}
          />
        </button>
      ) : (
        <div className="flex flex-col gap-4 p-5">
          {/* 态2 你的状态 — the viewer's own standing once RSVP'd; otherwise a 留位
              prompt (the reserve form sits below the card on the detail page). */}
          {standing !== "none" ? (
            <p className="text-sm font-semibold text-paper" data-viewer-status={standing}>
              {viewerStatusLabel(standing, t)}
            </p>
          ) : (
            <p className="text-sm font-semibold text-paper" data-viewer-status="none">
              {t("reservePrompt")}
            </p>
          )}

          {/* 成局进度 — 人数看板 (counts only, never a name list). */}
          <div className="flex flex-col gap-1" data-gathering-status={gathering}>
            <p className="text-sm text-paper/90">
              {t("goingCount", { count: goingCount })}
              {needed != null && needed > 0 ? (
                <span className="text-paper/70"> · {t("spotsNeeded", { count: needed })}</span>
              ) : null}
            </p>
            <p className="text-xs text-muted">{gatheringStatusLabel(gathering, t)}</p>
          </div>

          {/* Second tap expands the role-specific form (guest edit / host manage).
              Only when a form is actually supplied — a card with no children shows no
              dangling expand control (the 局详情 page renders its reserve form as a
              sibling below the card instead). */}
          {children != null ? (
            <>
              <button
                type="button"
                onClick={advance}
                aria-expanded={expanded}
                className="self-start text-sm font-semibold text-iris underline-offset-2 hover:underline"
              >
                {expanded
                  ? t("collapse")
                  : mode === "host"
                    ? t("expandManage")
                    : t("expandEdit")}
              </button>

              {expanded ? <div>{children}</div> : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The viewer's-standing label (态2 你的状态). `none` is never rendered (guarded above). */
function viewerStatusLabel(
  status: ViewerStatus,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (status) {
    case "reserved":
      return t("statusReserved");
    case "locked-seat":
      return t("statusLockedSeat");
    default:
      return "";
  }
}

/** The gathering-progress label (报名中 / 已满待成局 / 已成局). */
function gatheringStatusLabel(
  status: GatheringStatus,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (status) {
    case "full-pending":
      return t("gatheringFullPending");
    case "formed":
      return t("gatheringFormed");
    default:
      return t("gatheringOpen");
  }
}

/**
 * Whether the face-flip animation should run. Honors `prefers-reduced-motion: reduce`
 * (the global CSS already neutralises the transition; this also lets us drop the class so
 * the swap is a clean instant cut). Starts `false` so SSR/first paint is motion-free, then
 * enables after mount only when the user hasn't asked for reduced motion.
 */
function useAnimationEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setEnabled(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return enabled;
}
