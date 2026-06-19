import { describe, expect, it } from "vitest";

import {
  cardScanUrl,
  gatheringStatus,
  initialCardState,
  spotsNeeded,
  viewerStatus,
} from "../lib/events/card";
import type { RsvpRecord } from "../lib/events/rsvp-storage";

/**
 * Step-10A task 2 — INDEPENDENT pure unit test for `lib/events/card.ts`.
 *
 * The card module is the single tested "brain" of the 局卡 state machine + 成局 math:
 * it decides which face to show (态1 art / 态2 personal), the viewer's own standing,
 * the gathering's public progress, the 缺X人 countdown, and the absolute QR URL.
 *
 * Per its own contract it is PURE — no `server-only`, no DB, no React, no `Date.now()` —
 * so this whole suite runs at the value boundary with NO database. We pin each documented
 * branch with explicit inputs (including the null/over-capacity/undefined edges) so the
 * component and the server image route can never disagree with the tested rules.
 */

// A minimal valid cached RSVP. Only `viewerStatus` consumes a record, and only for
// presence/absence — its fields don't influence the branch — so a realistic stub suffices.
const RSVP: RsvpRecord = {
  token: "tok_abc123",
  status: "going",
  plus_ones: 0,
  display_name: "Wei",
  contact: null,
  wechat_id: null,
};

describe("step-10A card.ts: spotsNeeded (缺 X 人 countdown over remainingSpots)", () => {
  it("returns null when capacity is unbounded (null/undefined) — nothing to count down", () => {
    expect(spotsNeeded(null, 0)).toBeNull();
    expect(spotsNeeded(null, 5)).toBeNull();
    expect(spotsNeeded(undefined, 3)).toBeNull();
  });

  it("returns the non-negative shortfall when a target exists", () => {
    expect(spotsNeeded(10, 0)).toBe(10);
    expect(spotsNeeded(10, 4)).toBe(6);
    expect(spotsNeeded(1, 0)).toBe(1);
  });

  it("returns 0 exactly when the target is met (满)", () => {
    expect(spotsNeeded(10, 10)).toBe(0);
  });

  it("clamps to 0 when over capacity (host shrank the cap below headcount) — never negative", () => {
    expect(spotsNeeded(10, 15)).toBe(0);
    expect(spotsNeeded(0, 3)).toBe(0);
  });
});

describe("step-10A card.ts: viewerStatus (your own standing on 态2)", () => {
  it("none when there is no cached RSVP — regardless of unlock/lock signals", () => {
    expect(viewerStatus({ record: null, unlocked: undefined, isLocked: undefined })).toBe(
      "none",
    );
    expect(viewerStatus({ record: null, unlocked: true, isLocked: true })).toBe("none");
  });

  it("reserved when RSVP'd but the gathering is not locked (留位中 / 等确认)", () => {
    expect(viewerStatus({ record: RSVP, unlocked: false, isLocked: false })).toBe(
      "reserved",
    );
    expect(
      viewerStatus({ record: RSVP, unlocked: undefined, isLocked: undefined }),
    ).toBe("reserved");
    // Unlocked but not locked is still just reserved.
    expect(viewerStatus({ record: RSVP, unlocked: true, isLocked: false })).toBe(
      "reserved",
    );
  });

  it("locked-seat ONLY when RSVP'd AND isLocked AND this viewer unlocked (已锁定席位)", () => {
    expect(viewerStatus({ record: RSVP, unlocked: true, isLocked: true })).toBe(
      "locked-seat",
    );
  });

  it("a stale isLocked WITHOUT this viewer's unlock reads as merely reserved", () => {
    expect(viewerStatus({ record: RSVP, unlocked: false, isLocked: true })).toBe(
      "reserved",
    );
    expect(
      viewerStatus({ record: RSVP, unlocked: undefined, isLocked: true }),
    ).toBe("reserved");
  });
});

describe("step-10A card.ts: gatheringStatus (成局进度 public board)", () => {
  it("formed whenever the event is locked — locking dominates the count (已成局)", () => {
    expect(gatheringStatus({ capacity: 10, goingCount: 2, isLocked: true })).toBe(
      "formed",
    );
    // Locked wins even with an unbounded capacity / a met target.
    expect(gatheringStatus({ capacity: null, goingCount: 0, isLocked: true })).toBe(
      "formed",
    );
    expect(gatheringStatus({ capacity: 5, goingCount: 5, isLocked: true })).toBe(
      "formed",
    );
  });

  it("full-pending when going >= capacity but NOT locked (满但未锁 → 确认成局？)", () => {
    expect(gatheringStatus({ capacity: 10, goingCount: 10, isLocked: false })).toBe(
      "full-pending",
    );
    // Over-capacity (shortfall clamps to 0) is still full-pending, not formed.
    expect(gatheringStatus({ capacity: 10, goingCount: 12, isLocked: false })).toBe(
      "full-pending",
    );
  });

  it("open while seats remain (报名中)", () => {
    expect(gatheringStatus({ capacity: 10, goingCount: 3, isLocked: false })).toBe(
      "open",
    );
    expect(gatheringStatus({ capacity: 10, goingCount: 9, isLocked: false })).toBe(
      "open",
    );
  });

  it("open when capacity is unbounded and not locked — null shortfall is never full", () => {
    expect(gatheringStatus({ capacity: null, goingCount: 0, isLocked: false })).toBe(
      "open",
    );
    expect(
      gatheringStatus({ capacity: undefined, goingCount: 100, isLocked: undefined }),
    ).toBe("open");
  });
});

describe("step-10A card.ts: initialCardState (which face the card OPENS on)", () => {
  it("personal ONLY for a guest who already has an RSVP (cached token)", () => {
    expect(initialCardState({ mode: "guest", hasRsvp: true })).toBe("personal");
  });

  it("art for a guest who has not yet RSVP'd (the thing they just scanned)", () => {
    expect(initialCardState({ mode: "guest", hasRsvp: false })).toBe("art");
  });

  it("art for a host whether or not they happen to have an RSVP (share/save first)", () => {
    expect(initialCardState({ mode: "host", hasRsvp: false })).toBe("art");
    expect(initialCardState({ mode: "host", hasRsvp: true })).toBe("art");
  });
});

describe("step-10A card.ts: cardScanUrl (absolute /[slug] QR target)", () => {
  it("composes a single well-formed absolute URL from origin + slug", () => {
    expect(cardScanUrl("https://ju.app", "summer-bbq")).toBe(
      "https://ju.app/summer-bbq",
    );
  });

  it("trims trailing slashes on the origin (no doubled slash)", () => {
    expect(cardScanUrl("https://ju.app/", "summer-bbq")).toBe(
      "https://ju.app/summer-bbq",
    );
    expect(cardScanUrl("https://ju.app///", "summer-bbq")).toBe(
      "https://ju.app/summer-bbq",
    );
  });

  it("URL-encodes the slug so the result is always a valid single URL", () => {
    expect(cardScanUrl("https://ju.app", "a b/c")).toBe("https://ju.app/a%20b%2Fc");
    expect(cardScanUrl("https://ju.app", "café")).toBe("https://ju.app/caf%C3%A9");
  });

  it("works with a localhost origin (client-side window.location.origin shape)", () => {
    expect(cardScanUrl("http://localhost:3000", "x")).toBe("http://localhost:3000/x");
  });
});
