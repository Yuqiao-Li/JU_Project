import { eventViewSchema, type EventView } from "./view";

/**
 * Pure classifier for the `get_event_by_slug` RPC result (fail-loud hardening).
 *
 * WHY THIS IS A SEPARATE, PURE MODULE. The trusted read in `read-event.ts` is
 * `server-only` and `@/`-aliased, so it can't be exercised under this repo's vitest
 * harness (node, no `server-only` stub, no `@/` alias). The CLASSIFICATION decision —
 * "is this absence a real missing event, or an infra failure I must not hide?" — is the
 * security-sensitive part, so it lives here as a pure function: no DB client, no Next
 * imports, no `server-only`, no `"use client"`, and only a RELATIVE import of the pure
 * (zod-only) `./view` schema. That keeps it unit-testable in isolation.
 *
 * FAIL-LOUD RATIONALE (mirrors read-public-events.ts's "ERROR vs EMPTY (H20)").
 * The old tail collapsed `error || data == null` into a single `return null`, and callers
 * turn null into `notFound()` → HTTP 404. So a misconfigured deployment — a wrong/expired
 * service-role key, or a `get_event_by_slug` whose signature/schema is behind the app —
 * made EVERY event page render a misleading 404 with the real cause swallowed and nothing
 * to diagnose. We now split that fork:
 *   • a genuine RPC `error`  → THROW (→ 500 / app/error.tsx), surfacing the infra fault;
 *   • a schema-validation failure on a non-null payload → THROW (likely app↔DB schema
 *     drift), rather than silently 404-ing a row the DB actually returned;
 *   • only a clean `data == null` with NO error stays the legitimate "not found" path.
 *
 * INDISTINGUISHABILITY INVARIANT (SCHEMA D3 / 安全模型 §3 — SECURITY-CRITICAL).
 * `get_event_by_slug` returns `data == null` with NO error for BOTH a truly unknown slug
 * AND a private-event denial. Those two cases MUST remain indistinguishable to the caller
 * (both → null → 404), otherwise the 404-vs-something-else difference becomes an existence
 * oracle that leaks whether a private event exists. So the `data == null` branch must
 * stay a quiet `return null` and must NEVER throw or otherwise vary by reason.
 */

/**
 * The minimal shape of a `supabase-js` RPC result we classify. The real
 * `PostgrestSingleResponse` is structurally wider but compatible: its `error` is a
 * `PostgrestError | null` (which carries `.message` and `.code`), and `data` is `unknown`
 * to us here.
 */
export interface EventRpcResult {
  data: unknown;
  error: { message: string; code?: string | null } | null;
}

/**
 * Classify a `get_event_by_slug` RPC result into the event façade, a clean null, or a
 * thrown infra/drift error. See the module doc comment for the full fail-loud rationale
 * and the indistinguishability invariant.
 *
 * @param slug   the slug that was looked up (for diagnosable error messages only).
 * @param result the `{ data, error }` returned by `supabase.rpc("get_event_by_slug", …)`.
 * @returns the validated `EventView` on success, or `null` for a clean not-found /
 *          private-denial (both indistinguishable). THROWS on a transport/auth/RPC error
 *          or on schema-validation failure of a non-null payload.
 */
export function resolveEventReadResult(
  slug: string,
  result: EventRpcResult,
): EventView | null {
  if (result.error) {
    // Infra/config fault, NOT a missing event — fail loud so a wrong/expired
    // service-role key or a behind-the-app RPC signature/schema surfaces as a 500
    // instead of a misleading 404. Never embed any key/JWT value here.
    throw new Error(
      `readEventBySlug: get_event_by_slug RPC failed for slug "${slug}" ` +
        `(code: ${result.error.code ?? "unknown"}, message: ${result.error.message}). ` +
        `This is an infrastructure/configuration error — likely the service-role key is ` +
        `wrong/expired, or the get_event_by_slug signature/schema is behind the app — ` +
        `NOT a missing event. Failing loud instead of rendering a misleading 404.`,
    );
  }

  // SECURITY-CRITICAL: a genuine unknown slug AND a private-event denial both arrive here
  // as `data == null` with no error, and MUST stay indistinguishable (both → null → 404).
  // Loose `==` so it catches both null and undefined. Do NOT throw on this path.
  if (result.data == null) return null;

  const parsed = eventViewSchema.safeParse(result.data);
  if (!parsed.success) {
    // The DB returned a non-null row that doesn't match the façade — almost certainly
    // schema drift between app and DB. Fail loud rather than silently 404 a real row.
    throw new Error(
      `readEventBySlug: get_event_by_slug payload failed schema validation for slug ` +
        `"${slug}". This likely indicates schema drift between the app and the database. ` +
        `Failing loud instead of rendering a silent 404.`,
    );
  }

  return parsed.data;
}
