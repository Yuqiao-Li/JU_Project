import { describe, expect, it } from "vitest";

import { resolveEventReadResult, type EventRpcResult } from "../lib/events/read-event-core";

/**
 * Black-box hardening tests for `resolveEventReadResult` — the pure classifier that
 * interprets the result of the `get_event_by_slug` RPC (lib/events/read-event-core.ts).
 *
 * This is a PURE function (no DB, no network, no env), so these tests construct the
 * `{ data, error }` envelopes by hand and assert the classification. NOTHING here is
 * derived from the implementation body — every expectation comes from the SPEC. The
 * point of the unit is to FAIL LOUD on infra/config faults (wrong/expired service-role
 * key, drifted RPC signature, un-parseable row) instead of silently degrading them into
 * a misleading 404. The one place it MUST stay quiet is the security-critical
 * not-found/private-denied collision, which the RPC returns identically.
 *
 * Coverage map (spec item → describe/it):
 *   1. RPC error → throws
 *   2. error precedence (error wins even with valid-looking data)
 *   3. message is diagnosable (contains slug + underlying error message + code)
 *   4. no secret leakage (no JWT `eyJ` / Bearer material in the thrown message)
 *   5. clean not-found (null/null) → null
 *   6. undefined data → null
 *   7. unknown-slug vs private-denied are INDISTINGUISHABLE → both null (no oracle)
 *   8. valid payload → parsed EventView (key fields round-trip)
 *   9. unknown keys stripped, not rejected (no third-tier leak through the façade)
 *  10. schema-drift payload → throws, message includes slug
 *
 * Valid/invalid payloads are built against the PUBLIC schema `lib/events/view.ts`:
 * REQUIRED = { slug, title, visibility } (all strings); everything else optional;
 * unknown keys are stripped by zod's default strip.
 */

// A minimal, schema-valid event façade: exactly the three required fields.
function validEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { slug: "the-real-slug", title: "The Real Party", visibility: "public", ...over };
}

const noError = null;

describe("resolveEventReadResult — fail-loud classifier (black box, pure)", () => {
  // ── 1. RPC error → throws ────────────────────────────────────────────────────
  it("THROWS when the RPC reports a transport/config error (must not swallow it)", () => {
    const result: EventRpcResult = {
      data: null,
      error: { message: "Invalid API key", code: "401" },
    };
    // A wrong/expired service-role key or a behind-the-app RPC signature surfaces here.
    expect(() => resolveEventReadResult("some-slug", result)).toThrow();
  });

  // ── 2. Error precedence — error wins even when data looks valid ───────────────
  it("THROWS even when data is a valid-looking payload but error is set (error wins)", () => {
    const result: EventRpcResult = {
      data: validEvent(),
      error: { message: "connection reset by peer", code: "ECONNRESET" },
    };
    // Never return a value when the transport reported an error.
    expect(() => resolveEventReadResult("precedence-slug", result)).toThrow();
  });

  // ── 3. Diagnosable error message: slug + underlying message (+ code) ──────────
  it("surfaces the slug AND the underlying error message in the thrown error", () => {
    const SLUG = "diagnose-me-7f3a9";
    const ERRMSG = "JWT expired at 2024-01-01T00:00:00Z";
    const result: EventRpcResult = {
      data: null,
      error: { message: ERRMSG, code: "PGRST301" },
    };

    let caught: unknown;
    try {
      resolveEventReadResult(SLUG, result);
    } catch (e) {
      caught = e;
    }
    expect(caught, "expected a throw").toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg, "message must name the slug for debuggability").toContain(SLUG);
    expect(msg, "message must surface the underlying error text").toContain(ERRMSG);
    // The code is "ideally" present — assert it too; the SPEC asks us to surface it.
    expect(msg, "message should surface the underlying code").toContain("PGRST301");
  });

  // ── 4. No secret leakage (cheap regression guard) ────────────────────────────
  it("does NOT echo JWT/Bearer-like key material in the thrown message", () => {
    const SLUG = "no-leak-slug";
    // Even though the envelope carries no secret, pin the guard: the message must not
    // contain a JWT prefix or Bearer scheme.
    const result: EventRpcResult = {
      data: null,
      error: { message: "permission denied for function get_event_by_slug", code: "42501" },
    };
    let msg = "";
    try {
      resolveEventReadResult(SLUG, result);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg, "sanity: it did throw").not.toBe("");
    expect(msg).not.toContain("eyJ"); // JWT header prefix
    expect(msg.toLowerCase()).not.toContain("bearer");
  });

  // ── 5. Clean not-found (null/null) → null ────────────────────────────────────
  it("returns null (NOT a throw) for the legitimate not-found path: data null, error null", () => {
    const result: EventRpcResult = { data: null, error: noError };
    expect(resolveEventReadResult("missing-event", result)).toBeNull();
  });

  // ── 6. Undefined data → null ─────────────────────────────────────────────────
  it("returns null when data is undefined and error is null (loose-null catches undefined)", () => {
    const result: EventRpcResult = { data: undefined, error: noError };
    expect(resolveEventReadResult("undefined-data", result)).toBeNull();
  });

  // ── 7. Indistinguishability (SECURITY-CRITICAL) ──────────────────────────────
  it("treats unknown-slug and private-denied IDENTICALLY (both → null, no throw)", () => {
    // The RPC deliberately returns `{ data: null, error: null }` for BOTH a slug that
    // doesn't exist AND a private event the caller may not see. If this function could
    // tell them apart (one throws, one returns null), an attacker would have an existence
    // oracle: a different reaction would leak whether a private event exists. So both
    // MUST classify to the exact same outcome.
    const unknownSlug: EventRpcResult = { data: null, error: noError };
    const privateDenied: EventRpcResult = { data: null, error: noError };

    let unknownOut: unknown;
    let privateOut: unknown;
    expect(() => {
      unknownOut = resolveEventReadResult("totally-made-up-slug", unknownSlug);
    }).not.toThrow();
    expect(() => {
      privateOut = resolveEventReadResult("a-real-private-event", privateDenied);
    }).not.toThrow();

    expect(unknownOut).toBeNull();
    expect(privateOut).toBeNull();
    expect(unknownOut).toEqual(privateOut); // indistinguishable
  });

  // ── 8. Valid payload → parsed EventView (key fields round-trip) ───────────────
  it("returns a parsed EventView for a well-formed payload (required fields round-trip)", () => {
    const payload = validEvent({
      id: "evt-123",
      description: "come on down",
      visibility: "private",
      rsvp_enabled: true,
    });
    const out = resolveEventReadResult("the-real-slug", { data: payload, error: noError });
    expect(out).not.toBeNull();
    expect(out?.slug).toBe("the-real-slug");
    expect(out?.title).toBe("The Real Party");
    expect(out?.visibility).toBe("private");
    expect(out?.id).toBe("evt-123");
    expect(out?.rsvp_enabled).toBe(true);
  });

  // ── 9. Unknown keys stripped, not rejected (defense in depth) ────────────────
  it("STRIPS unknown/third-tier keys instead of throwing (no leak through the façade)", () => {
    // A hypothetical leaked third-tier field must neither crash the parse nor survive it.
    const payload = validEvent({
      contact: "host-private-email@example.com",
      guest_token: "11111111-2222-3333-4444-555555555555",
      view_password_hash: "$2b$12$some.bcrypt.hash.value.that.must.not.surface",
    });
    let out: ReturnType<typeof resolveEventReadResult>;
    expect(() => {
      out = resolveEventReadResult("strip-extras", { data: payload, error: noError });
    }).not.toThrow();
    expect(out!).not.toBeNull();
    // The extras are absent from the returned façade.
    expect(Object.prototype.hasOwnProperty.call(out!, "contact")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out!, "guest_token")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out!, "view_password_hash")).toBe(false);
    // …and not lurking anywhere in the serialized result.
    expect(JSON.stringify(out!)).not.toContain("host-private-email@example.com");
    expect(JSON.stringify(out!)).not.toContain("view_password_hash");
    // The legitimate fields still round-trip.
    expect(out!.slug).toBe("the-real-slug");
  });

  // ── 10. Schema-drift payload → throws, message includes slug ─────────────────
  describe("schema drift → fail loud (DB returned a row the app can't parse)", () => {
    it("THROWS when a REQUIRED field is missing (omit `visibility`)", () => {
      const SLUG = "drift-missing-required";
      // Omit the required `visibility` string.
      const broken = { slug: "the-real-slug", title: "The Real Party" };
      let msg = "";
      expect(() => {
        try {
          resolveEventReadResult(SLUG, { data: broken, error: noError });
        } catch (e) {
          msg = (e as Error).message;
          throw e;
        }
      }).toThrow();
      expect(msg, "drift error must name the slug").toContain(SLUG);
    });

    it("THROWS when a REQUIRED field has the wrong type (`title` is a number)", () => {
      const SLUG = "drift-wrong-type";
      const broken = { slug: "the-real-slug", title: 12345, visibility: "public" };
      expect(() => resolveEventReadResult(SLUG, { data: broken, error: noError })).toThrow();
    });
  });
});
