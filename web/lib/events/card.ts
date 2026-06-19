/**
 * 局卡 (event-card) pure helpers (Step-10A, task 2) — the single, tested source of the
 * card's STATE MACHINE and its 成局 (gathering) presentation math.
 *
 * The card is JU's cornerstone shareable: a two-state digital ticket-stub that fuses a
 * share entry (态1 art + QR) with a personalised progress face (态2). This module holds
 * the *decisions* — which face to show, what the viewer's standing is, how far the
 * gathering has progressed, how many heads are still needed — so the React component and
 * the server image route both render from one tested brain rather than re-deriving the
 * same rules ad hoc.
 *
 * Kept PURE (no `server-only`, no DB, no React, no `@/` alias, no `Date.now()`) so it
 * unit-tests at the RPC/value boundary without a database — mirrors capacity.ts / og.ts.
 *
 * FIRST-TIER DISCIPLINE: nothing here reads a second/third-tier field (full address,
 * guest list, contact). It composes only public façade numbers + the viewer's OWN cached
 * RSVP, so a value computed here can never leak a gated field into the public art face.
 */

import { remainingSpots } from "./capacity";
import type { RsvpRecord } from "./rsvp-storage";

/**
 * The two card faces (态1/态2). 态3 (back, big QR) is deferred — see event-card.md
 * 缓做/不做 — so this union is intentionally just two members and additive-ready.
 *
 *  - `art`      态1 正面·艺术视觉: time + city + small QR; the share/save face.
 *  - `personal` 态2 个人化·进度: your standing + 成局 progress + expand-to-form.
 */
export type CardState = "art" | "personal";

/**
 * The viewing context that decides which face the card OPENS on.
 *
 * Per event-card.md 流程: a host right after publishing, and a returning host, both meet
 * the card at 态1 (art) — they share/save the poster first, then flip to progress. A
 * guest who has NOT yet RSVP'd also opens on the art face (the thing they just scanned).
 * A guest who HAS already RSVP'd (a returning, cached token) opens straight on 态2 — the
 * page becomes "their" personalised stub. The component still lets either role flip
 * between faces; this only picks the *initial* one.
 */
export interface CardContext {
  /** Page role — a host owns the event; a guest is anonymous (token-only). */
  mode: "host" | "guest";
  /** True once this viewer has a confirmed RSVP for the event (cached token present). */
  hasRsvp: boolean;
}

/**
 * The face the card should open on for a given context. Only a guest WITH an RSVP opens
 * on the personalised face; everyone else (host post-publish, returning host, guest
 * pre-RSVP) opens on the shareable art face.
 */
export function initialCardState(ctx: CardContext): CardState {
  return ctx.mode === "guest" && ctx.hasRsvp ? "personal" : "art";
}

/**
 * 缺 X 人 — heads still needed to hit the 成局 target. A thin, named composition over
 * {@link remainingSpots} (capacity − going, clamped ≥ 0): null when the event has no
 * target (unbounded capacity — nothing to count down), else the non-negative shortfall.
 * Reusing remainingSpots keeps the "已 N 人 / 缺 X 人" board and the public "spots left"
 * line on ONE accounting so they can never drift apart (capacity.ts is the authority).
 */
export function spotsNeeded(
  capacity: number | null | undefined,
  goingCount: number,
): number | null {
  return remainingSpots(capacity, goingCount);
}

/**
 * The viewer's OWN standing on the card (态2 "你的状态"), or `none` when they have no
 * RSVP yet. Derived purely from the viewer's cached RSVP + the façade's unlock/lock
 * signals — never from another guest's data.
 *
 *  - `none`        no RSVP — show the 留位 (reserve) entry, not a standing.
 *  - `reserved`    留位中 — RSVP'd, gathering NOT yet formed/locked (等确认).
 *  - `locked-seat` 已锁定席位 — RSVP'd AND the gathering is locked (seat is secured).
 *
 * `unlocked` (the viewer's tier was revealed) is required for `locked-seat` because the
 * locked-seat standing is only meaningful for THIS guest once their own RSVP is the one
 * that unlocked the event — a stale `is_locked` without this viewer's unlock reads as
 * still merely `reserved`.
 */
export type ViewerStatus = "none" | "reserved" | "locked-seat";

export function viewerStatus(args: {
  record: RsvpRecord | null;
  unlocked: boolean | undefined;
  isLocked: boolean | undefined;
}): ViewerStatus {
  if (!args.record) return "none";
  return args.isLocked === true && args.unlocked === true ? "locked-seat" : "reserved";
}

/**
 * 成局进度 — the gathering's overall standing (态2 progress board), the SAME for every
 * viewer (a 人数看板, never a name list).
 *
 *  - `open`         报名中 — still taking 留位 (seats remain / no target / not locked).
 *  - `full-pending` 已满待成局 — going ≥ capacity but NOT yet locked: this is the
 *                   "满 → 提示 host 确认" trigger (README 跨页契约) — full, awaiting the
 *                   host's one-tap 成局 confirmation.
 *  - `formed`       已成局 — the gathering is formed.
 *
 * 成局 SEMANTICS (README ⚠️ 成局 ≠ 锁定): the contract is "成局 = 凑满(going≥capacity)
 * OR host 手动锁(locked_at 非空); 纯到时自动锁 NOT counted". The PUBLIC façade only
 * surfaces `is_locked` (which folds manual AND auto lock together) and cannot, by tier
 * design, expose `locked_at`. So at the card layer we treat the BEST available public
 * signal: a locked event reads as `formed`. The "满但未锁" case is reported distinctly as
 * `full-pending` so the host UI can raise the "确认成局？" prompt. A future façade that
 * adds a manual-lock-only flag can refine `formed` here without changing call sites.
 */
export type GatheringStatus = "open" | "full-pending" | "formed";

export function gatheringStatus(args: {
  capacity: number | null | undefined;
  goingCount: number;
  isLocked: boolean | undefined;
}): GatheringStatus {
  if (args.isLocked === true) return "formed";
  const needed = spotsNeeded(args.capacity, args.goingCount);
  // needed === 0 ⇒ a real target exists and it is met (满) but not yet locked.
  if (needed === 0) return "full-pending";
  return "open";
}

/**
 * The absolute `/{slug}` URL the 态1 QR encodes (event-card.md: QR = 编码 /[slug] 绝对链接,
 * phone-camera scan → /[slug], no in-app scanner). Pure: the caller supplies the origin
 * (the request origin server-side, or `window.location.origin` client-side) so this stays
 * DB/React-free and unit-testable.
 *
 * Trailing slashes on the origin are trimmed and the slug is URL-encoded so the result is
 * always a single well-formed absolute URL regardless of how the origin was passed.
 */
export function cardScanUrl(origin: string, slug: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(slug)}`;
}
