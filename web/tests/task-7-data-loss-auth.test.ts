import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostClient, infra } from "./helpers/clients";
import { localStackRunning } from "./setup/local-supabase";

/**
 * Batch 7 [DATA-LOSS + AUTH] — audit H19 / H20 / H21 / H22 / M49.
 *
 * Written by the INDEPENDENT adversarial test agent. Stance per defect:
 *
 *   H22 — the "check your email" dead end: a magic link that never arrives leaves
 *         the user with NO resend, no cooldown, no spam hint. Assume a regression
 *         dropped the resend control, the cooldown gate, or duplicated a divergent
 *         OTP send path that drifts from the primary one.
 *   M49 — assume the callback origin is built from `window.location.origin`, which
 *         is an off-allowlist origin behind a proxy / custom domain, instead of the
 *         configured NEXT_PUBLIC_SITE_URL.
 *   H21 — assume the auth callback ignores provider/OTP `error*` params and dumps
 *         every failure on the generic "link expired" page (telling a user who
 *         cancelled Google that their link expired), with no reason classification.
 *   H19 — assume an empty username field silently writes username=null and deletes
 *         the public /u/<handle> — the irreversible data-loss bug. The SERVER must
 *         refuse the clear without an explicit confirm; a legitimate set/change of
 *         a username must STILL go through untouched.
 *   H20 — assume a transient RPC/fetch error collapses into the cheerful empty
 *         state ("No events yet"), hiding real events. The reader must THROW on a
 *         genuine error (route boundary → retry) yet still degrade a null/empty
 *         payload (no error) to [] (D2 no-existence-oracle).
 *
 * The React client + Next server actions can't be rendered/imported under vitest
 * (`"use client"` / `"use server"` / `@/`-alias / next/cache / window), so those
 * invariants are pinned on the SOURCE TEXT — the same static-guard posture the
 * task-4 lifecycle suite uses. The one place a real behavioural regression can be
 * proven at runtime — that a legitimate username set/change still writes (H19
 * "unaffected") — is exercised against the live test DB.
 */

/** Read an implementation source file by repo-relative path (relative to this test). */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

const LOGIN = src("components/auth/login-form.tsx");
const CALLBACK = src("app/auth/callback/route.ts");
const ERROR_PAGE = src("app/auth/auth-code-error/page.tsx");
const PROFILE_FORM = src("app/dashboard/settings/profile-form.tsx");
const SETTINGS_ACTIONS = src("app/dashboard/settings/actions.ts");
const DASHBOARD = src("app/dashboard/page.tsx");
const SETTINGS_PAGE = src("app/dashboard/settings/page.tsx");
const READ_PUBLIC = src("lib/events/read-public-events.ts");

const EN = JSON.parse(src("messages/en.json"));
const ZH = JSON.parse(src("messages/zh.json"));

// ─────────────────────────────────────────────────────────────────────────────
// H22 — login form: resend control + cooldown + spam hint + shared OTP path.
// ─────────────────────────────────────────────────────────────────────────────

describe("Batch 7 [H22]: magic-link resend with cooldown + spam hint (login-form.tsx)", () => {
  it("the SENT state offers a resend control (not just 'use a different email')", () => {
    // Crux of H22: the user whose mail is delayed must have a resend button. The
    // control text comes from a `resend`-family key, not a hard-coded string.
    expect(
      /onClick=\{?\s*resend/.test(LOGIN) || /t\(\s*["']resend["']\s*\)/.test(LOGIN),
      "login-form: a resend button/handler exists on the sent state",
    ).toBe(true);
  });

  it("a cooldown countdown gates the resend — a timer + a disabled-while-counting state + a resendIn-style label", () => {
    // A real timer ticks the countdown down (interval, not a one-shot timeout).
    expect(
      /setInterval\(/.test(LOGIN),
      "login-form: a setInterval drives the cooldown countdown",
    ).toBe(true);
    expect(
      /clearInterval\(/.test(LOGIN),
      "login-form: the cooldown interval is cleared (no leak / runaway tick)",
    ).toBe(true);
    // The resend is disabled while the cooldown is counting (cooldown > 0).
    expect(
      /disabled=\{[^}]*cooldown\s*>\s*0/.test(LOGIN) ||
        /cooldown\s*>\s*0[^}]*\|\|[^}]*resending/.test(LOGIN),
      "login-form: resend is disabled while the cooldown is counting",
    ).toBe(true);
    // A countdown label keyed on a resendIn-style message shows the seconds left.
    expect(
      /t\(\s*["']resendIn["']\s*,\s*\{\s*seconds/.test(LOGIN),
      "login-form: a resendIn({seconds}) label shows the remaining cooldown",
    ).toBe(true);
  });

  it("the cooldown is armed AFTER a successful send (so the gate actually engages)", () => {
    // A regression that never sets the cooldown would render an always-enabled
    // resend that lets users hammer the OTP endpoint. There must be a setter that
    // pushes the cooldown to a positive value after the send succeeds.
    expect(
      /setCooldown\(\s*RESEND_COOLDOWN/.test(LOGIN) || /setCooldown\(\s*\d{2}/.test(LOGIN),
      "login-form: the cooldown is set to a positive value after sending",
    ).toBe(true);
  });

  it("shows a spam-folder hint on the sent state", () => {
    expect(/t\(\s*["']spamHint["']\s*\)/.test(LOGIN), "login-form: renders the spamHint").toBe(true);
  });

  it("resend REUSES the single OTP send path — no second, divergent signInWithOtp call", () => {
    // H22 fix must not fork into a duplicated send that drifts (different redirect /
    // missing email). There is exactly ONE signInWithOtp call site, factored into a
    // shared helper both the submit and the resend invoke.
    const otpCalls = LOGIN.match(/signInWithOtp\(/g) ?? [];
    expect(
      otpCalls.length,
      "login-form: exactly one signInWithOtp call site (shared by submit + resend)",
    ).toBe(1);
    // Both entry points go through the same helper.
    expect(
      /sendMagicLink|onSubmit/.test(LOGIN) && /resend/i.test(LOGIN),
      "login-form: both submit and resend exist",
    ).toBe(true);
    const helper = LOGIN.match(/(?:const|function)\s+sendOtp\b/);
    expect(helper, "login-form: a shared sendOtp helper wraps the single OTP call").not.toBeNull();
    // The shared helper is invoked from both the submit and the resend.
    const sendOtpCalls = LOGIN.match(/sendOtp\(/g) ?? [];
    expect(
      sendOtpCalls.length,
      "login-form: the shared sendOtp helper is called from both submit and resend (definition + ≥2 calls)",
    ).toBeGreaterThanOrEqual(2);
  });

  it("the new auth.{resend,resending,resendIn,spamHint} keys exist in BOTH catalogs (no missing-key fallback)", () => {
    for (const [name, cat] of [["en", EN], ["zh", ZH]] as const) {
      for (const key of ["resend", "resending", "resendIn", "spamHint"] as const) {
        const v = cat?.auth?.[key];
        expect(typeof v === "string" && v.length > 0, `${name}.auth.${key} present`).toBe(true);
      }
      // resendIn must carry the {seconds} placeholder it's called with.
      expect(
        String(cat.auth.resendIn).includes("{seconds}"),
        `${name}.auth.resendIn interpolates {seconds}`,
      ).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M49 — redirect origin prefers NEXT_PUBLIC_SITE_URL (trimmed, no trailing slash).
// ─────────────────────────────────────────────────────────────────────────────

describe("Batch 7 [M49]: callback origin prefers NEXT_PUBLIC_SITE_URL (login-form.tsx)", () => {
  it("the origin helper reads NEXT_PUBLIC_SITE_URL", () => {
    expect(
      /process\.env\.NEXT_PUBLIC_SITE_URL/.test(LOGIN),
      "login-form: the callback origin is derived from NEXT_PUBLIC_SITE_URL",
    ).toBe(true);
  });

  it("the configured value is trimmed and has any trailing slash stripped", () => {
    expect(
      /NEXT_PUBLIC_SITE_URL\?\.trim\(\)/.test(LOGIN) ||
        /NEXT_PUBLIC_SITE_URL[\s\S]{0,40}\.trim\(\)/.test(LOGIN),
      "login-form: NEXT_PUBLIC_SITE_URL is trimmed",
    ).toBe(true);
    expect(
      /\.replace\(\s*\/\\\/\$\/[^)]*\)/.test(LOGIN) || /replace\(\/\\\/\$\//.test(LOGIN),
      "login-form: a trailing slash is stripped from the configured origin",
    ).toBe(true);
  });

  it("falls back to window.location.origin only when the env var is absent", () => {
    expect(
      /window\.location\.origin/.test(LOGIN),
      "login-form: window.location.origin is the dev fallback",
    ).toBe(true);
    // The env var must be the PREFERRED source: the configured value is consulted
    // before the actual `return window.location.origin` fallback STATEMENT. (We key
    // on the env READ — `process.env.NEXT_PUBLIC_SITE_URL` — and the fallback
    // `return window.location.origin`, ignoring the doc-comment mentions so the
    // ordering reflects real code, not prose.)
    const envIdx = LOGIN.indexOf("process.env.NEXT_PUBLIC_SITE_URL");
    const fallbackIdx = LOGIN.search(/return\s+window\.location\.origin/);
    expect(envIdx, "login-form: process.env.NEXT_PUBLIC_SITE_URL is read in code").toBeGreaterThanOrEqual(0);
    expect(fallbackIdx, "login-form: `return window.location.origin` is the fallback statement").toBeGreaterThanOrEqual(0);
    expect(
      fallbackIdx,
      "login-form: the env read precedes the window.location.origin fallback (env is preferred)",
    ).toBeGreaterThan(envIdx);
  });

  it("the callback URL is built from the resolved origin, not raw window.location", () => {
    // The /auth/callback URL must be assembled from the resolved site origin so the
    // env-derived origin actually wins. A regression that templated
    // `${window.location.origin}/auth/callback` directly would bypass M49.
    expect(
      /\$\{\s*siteOrigin\(\)\s*\}\/auth\/callback/.test(LOGIN) ||
        /siteOrigin\(\)[\s\S]{0,80}auth\/callback/.test(LOGIN),
      "login-form: the callback URL uses the resolved siteOrigin()",
    ).toBe(true);
    expect(
      /\$\{\s*window\.location\.origin\s*\}\/auth\/callback/.test(LOGIN),
      "login-form: the callback URL must NOT be built straight from window.location.origin",
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H21 — auth callback reads error params, classifies, redirects with a reason;
//        the error page renders the reason-specific localized copy.
// ─────────────────────────────────────────────────────────────────────────────

describe("Batch 7 [H21]: auth callback classifies provider/OTP errors (callback route + error page)", () => {
  it("the callback reads error / error_description / error_code from the query", () => {
    for (const param of ["error", "error_description", "error_code"] as const) {
      expect(
        new RegExp(`searchParams\\.get\\(\\s*["']${param}["']\\s*\\)`).test(CALLBACK),
        `callback: reads ${param}`,
      ).toBe(true);
    }
  });

  it("a present provider error short-circuits to the error page with a classified reason (not silent code/token handling)", () => {
    // The error branch must run BEFORE attempting code exchange / OTP verify, and it
    // must forward a coarse reason — never fall through to the generic path.
    expect(
      /if\s*\(\s*providerError\s*\)/.test(CALLBACK) || /if\s*\(\s*error\b[\s\S]{0,30}\)/.test(CALLBACK),
      "callback: branches on the presence of a provider error",
    ).toBe(true);
    expect(
      /classifyAuthError\(/.test(CALLBACK),
      "callback: classifies the provider error into a reason",
    ).toBe(true);
  });

  it("the classifier distinguishes cancelled vs expired vs server", () => {
    expect(/["']cancelled["']/.test(CALLBACK), "callback: a 'cancelled' reason").toBe(true);
    expect(/["']expired["']/.test(CALLBACK), "callback: an 'expired' reason").toBe(true);
    expect(/["']server["']/.test(CALLBACK), "callback: a 'server' reason").toBe(true);
    // access_denied (Google cancel) must map to 'cancelled', NOT the default expired.
    expect(
      /access_denied[\s\S]{0,60}["']cancelled["']/.test(CALLBACK),
      "callback: access_denied is classified as cancelled (the H21 mis-message bug)",
    ).toBe(true);
  });

  it("the redirect to the error page carries a `reason` query param", () => {
    expect(
      /auth-code-error\?\$\{[\s\S]*reason[\s\S]*\}/.test(CALLBACK) ||
        /URLSearchParams\(\s*\{\s*reason/.test(CALLBACK),
      "callback: the error redirect includes a reason param",
    ).toBe(true);
    expect(
      /auth-code-error/.test(CALLBACK),
      "callback: redirects to the auth-code-error page",
    ).toBe(true);
  });

  it("the error_description is logged server-side (diagnostics retained, never shown raw)", () => {
    expect(
      /console\.error/.test(CALLBACK) && /error_?[dD]escription|errorDescription/.test(CALLBACK),
      "callback: the error_description is logged server-side",
    ).toBe(true);
  });

  it("the error page reads the `reason` and renders a reason-specific localized message", () => {
    expect(
      /searchParams[\s\S]{0,40}reason/.test(ERROR_PAGE),
      "error page: reads the reason from searchParams",
    ).toBe(true);
    // The page keys translations on the reason via the nested auth.error.<reason> path.
    expect(
      /error\.\$\{[^}]*\}\.title/.test(ERROR_PAGE) || /`error\.\$\{/.test(ERROR_PAGE),
      "error page: renders auth.error.<reason>.{title,body}",
    ).toBe(true);
    // An unknown/missing reason falls back to a valid bucket (default 'expired').
    expect(
      /["']expired["']/.test(ERROR_PAGE),
      "error page: defaults an unknown reason to 'expired'",
    ).toBe(true);
  });

  it("the NESTED auth.error.{expired,cancelled,server}.{title,body} keys exist in BOTH catalogs and read distinctly", () => {
    for (const [name, cat] of [["en", EN], ["zh", ZH]] as const) {
      const err = cat?.auth?.error;
      expect(err && typeof err === "object", `${name}.auth.error is a nested object`).toBe(true);
      const titles = new Set<string>();
      const bodies = new Set<string>();
      for (const reason of ["expired", "cancelled", "server"] as const) {
        const node = err?.[reason];
        expect(node && typeof node === "object", `${name}.auth.error.${reason} present`).toBe(true);
        expect(
          typeof node?.title === "string" && node.title.length > 0,
          `${name}.auth.error.${reason}.title present`,
        ).toBe(true);
        expect(
          typeof node?.body === "string" && node.body.length > 0,
          `${name}.auth.error.${reason}.body present`,
        ).toBe(true);
        titles.add(node.title);
        bodies.add(node.body);
      }
      // The whole point of H21: cancelled vs expired vs server must NOT all read the
      // same "link expired" copy.
      expect(titles.size, `${name}: the three error titles are distinct`).toBe(3);
      expect(bodies.size, `${name}: the three error bodies are distinct`).toBe(3);
    }
  });

  it("the removed FLAT keys auth.errorTitle / auth.errorBody are gone from BOTH catalogs", () => {
    for (const [name, cat] of [["en", EN], ["zh", ZH]] as const) {
      expect(cat?.auth?.errorTitle, `${name}: flat auth.errorTitle removed`).toBeUndefined();
      expect(cat?.auth?.errorBody, `${name}: flat auth.errorBody removed`).toBeUndefined();
    }
  });

  it("no source still references the removed flat auth.errorTitle / auth.errorBody keys", () => {
    for (const [label, code] of [
      ["callback", CALLBACK],
      ["error page", ERROR_PAGE],
      ["login-form", LOGIN],
    ] as const) {
      expect(/errorTitle|errorBody/.test(code), `${label}: no reference to the flat error keys`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H19 — username-clear data-loss guard (profile-form client + server action).
// ─────────────────────────────────────────────────────────────────────────────

describe("Batch 7 [H19]: username-clear requires an explicit confirm (profile-form + actions)", () => {
  it("the client only flags a CLEAR when a username previously existed (not on a never-set field)", () => {
    expect(
      /clearingUsername\s*=\s*hadUsername\s*&&\s*trimmed\s*===\s*""/.test(PROFILE_FORM) ||
        /hadUsername[\s\S]{0,40}trimmed\s*===\s*""/.test(PROFILE_FORM),
      "profile-form: clearing is hadUsername && empty (H19)",
    ).toBe(true);
    expect(
      /initialUsername[\s\S]{0,40}!==\s*""/.test(PROFILE_FORM),
      "profile-form: 'had a username' is derived from a non-empty initial value",
    ).toBe(true);
  });

  it("the client requires an explicit confirm (checkbox) before a clear, with a warning naming /u/<old>", () => {
    expect(/type="checkbox"/.test(PROFILE_FORM), "profile-form: a confirm checkbox exists").toBe(true);
    expect(
      /confirmedClear|confirm_clear/.test(PROFILE_FORM),
      "profile-form: a confirm flag gates the clear",
    ).toBe(true);
    // The warning names the to-be-lost public handle.
    expect(
      /\/u\/\{?\s*initialUsername/.test(PROFILE_FORM) || /usernameClearWarning/.test(PROFILE_FORM),
      "profile-form: the warning names /u/<old handle>",
    ).toBe(true);
    // Submit is blocked until the clear is confirmed.
    expect(
      /disabled=\{[^}]*clearingUsername\s*&&\s*!confirmedClear/.test(PROFILE_FORM),
      "profile-form: the Save button is disabled until the clear is confirmed",
    ).toBe(true);
  });

  it("the client sends confirm_clear=true ONLY when the host actually confirmed the clear", () => {
    // A regression that hard-coded confirm_clear=true (or sent it unconditionally)
    // would defeat the whole guard.
    expect(
      /name="confirm_clear"\s+value=\{\s*clearingUsername\s*&&\s*confirmedClear\s*\?\s*["']true["']/.test(
        PROFILE_FORM,
      ),
      "profile-form: confirm_clear is true only when clearing AND confirmed",
    ).toBe(true);
    expect(
      /value=\{?\s*["']true["']\s*\}?[^>]*name="confirm_clear"/.test(PROFILE_FORM) ||
        /name="confirm_clear"\s+value="true"/.test(PROFILE_FORM),
      "profile-form: confirm_clear is NOT hard-coded to a constant true",
    ).toBe(false);
  });

  it("THE KEY GUARD — the SERVER action refuses to write username=null without confirm_clear, with the USERNAME_CLEAR_UNCONFIRMED sentinel", () => {
    // This is the irreversible data-loss protection. The action must, on an empty
    // username AND a previously-set value, require confirm_clear=true and otherwise
    // bail BEFORE the UPDATE.
    expect(
      /confirm_clear/.test(SETTINGS_ACTIONS),
      "actions: the server reads confirm_clear",
    ).toBe(true);
    expect(
      /USERNAME_CLEAR_UNCONFIRMED/.test(SETTINGS_ACTIONS),
      "actions: the refusal returns the USERNAME_CLEAR_UNCONFIRMED sentinel",
    ).toBe(true);
    // The refusal is conditioned on (had a previous username) AND (not confirmed),
    // and RETURNS before writing — proving the server doesn't trust the client gate.
    expect(
      /if\s*\(\s*previous\s*&&\s*!confirmed\s*\)\s*\{?\s*return/.test(SETTINGS_ACTIONS) ||
        /previous\s*&&\s*!confirmed[\s\S]{0,60}return\s*\{[\s\S]{0,80}USERNAME_CLEAR_UNCONFIRMED/.test(
          SETTINGS_ACTIONS,
        ),
      "actions: refuses (returns) when a username existed and the clear isn't confirmed",
    ).toBe(true);
    // The server re-reads the EXISTING username (not the form) to decide.
    expect(
      /from\(\s*["']profiles["']\s*\)[\s\S]{0,80}select\(\s*["']username["']/.test(SETTINGS_ACTIONS),
      "actions: re-reads the existing username server-side before allowing a clear",
    ).toBe(true);
  });

  it("a confirmed clear is NOT blocked — confirm_clear=true lets username=null through", () => {
    // The guard must only fire on the UNconfirmed path: when confirmed, control
    // falls through to the UPDATE with username=null. Assert the unconfirmed branch
    // is the ONLY thing that returns the sentinel (i.e. it's gated by !confirmed).
    const sentinelGatedByUnconfirmed =
      /!confirmed[\s\S]{0,80}USERNAME_CLEAR_UNCONFIRMED/.test(SETTINGS_ACTIONS);
    expect(
      sentinelGatedByUnconfirmed,
      "actions: the sentinel is returned only on the !confirmed path (a confirmed clear proceeds)",
    ).toBe(true);
  });

  it("the settings clear-warning / clear-confirm / clear-blocked keys exist in BOTH catalogs", () => {
    for (const [name, cat] of [["en", EN], ["zh", ZH]] as const) {
      for (const key of ["usernameClearWarning", "usernameClearConfirm", "usernameClearBlocked"] as const) {
        const v = cat?.settings?.[key];
        expect(typeof v === "string" && v.length > 0, `${name}.settings.${key} present`).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H20 — error vs empty: a real error THROWS; a null/empty payload degrades to [].
// ─────────────────────────────────────────────────────────────────────────────

describe("Batch 7 [H20]: a real RPC/fetch error throws (route boundary) instead of collapsing to empty", () => {
  it("dashboard/page.tsx THROWS on a get_my_events error (does not set events=[] on error)", () => {
    expect(
      /if\s*\(\s*error\s*\)\s*\{[\s\S]{0,200}throw\s+new\s+Error/.test(DASHBOARD),
      "dashboard: `if (error) … throw` so the error boundary shows a retry",
    ).toBe(true);
    // The empty state must NOT be reached by an error path: events comes from
    // parsing the feed AFTER the error guard, never `error ? [] : …`.
    expect(
      /error\s*\?\s*\[\]/.test(DASHBOARD),
      "dashboard: an error must NOT be coerced into an empty events array",
    ).toBe(false);
  });

  it("settings/page.tsx THROWS on a profile load error (no blank-default fallback that a save could wipe)", () => {
    expect(
      /if\s*\(\s*error\s*\)\s*\{[\s\S]{0,200}throw\s+new\s+Error/.test(SETTINGS_PAGE),
      "settings page: `if (error) … throw` instead of rendering blank defaults",
    ).toBe(true);
  });

  it("read-public-events.ts THROWS on a genuine RPC error", () => {
    expect(
      /if\s*\(\s*error\s*\)\s*\{[\s\S]{0,200}throw\s+new\s+Error/.test(READ_PUBLIC),
      "read-public-events: `if (error) … throw` on a hard RPC error (H20)",
    ).toBe(true);
  });

  it("read-public-events.ts STILL returns [] on a null-but-no-error payload (D2 no existence oracle)", () => {
    // The subtle other half of H20: an unknown handle / eventless host yields a
    // null/empty payload with NO error and must degrade to [], NOT throw — otherwise
    // every empty organizer profile would 500.
    expect(
      /if\s*\(\s*data\s*==\s*null\s*\)\s*return\s*\[\]/.test(READ_PUBLIC) ||
        /data\s*==\s*null[\s\S]{0,30}return\s*\[\]/.test(READ_PUBLIC),
      "read-public-events: a null payload with no error returns [] (not a throw)",
    ).toBe(true);
    // The throw must be gated strictly on `error`, never on an empty `data`.
    expect(
      /if\s*\(\s*!?\s*data\s*\)[\s\S]{0,40}throw/.test(READ_PUBLIC),
      "read-public-events: an empty data set must NOT trigger a throw",
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H19 (runtime) — a LEGITIMATE username set/change is unaffected by the guard.
//
// The server action can't be invoked under vitest, but its only DB effect is an
// UPDATE on the caller's own profiles row. We prove the underlying write the
// action performs on the HAPPY path (set a non-null username, then change it)
// still succeeds against the live test DB — i.e. the H19 guard does not regress
// the legitimate path it is layered on top of.
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_UP = localStackRunning();
const i = LOCAL_UP ? infra() : null;
const dbReady = LOCAL_UP && !!i?.dbReady;

describe("Batch 7 [H19 runtime]: legitimately setting/changing a username still writes (unaffected by the guard)", () => {
  let host: SupabaseClient | null = null;
  let hostId = "";

  beforeAll(() => {
    if (!dbReady || !i) return;
    expect(i.hosts.length).toBeGreaterThanOrEqual(1);
    host = hostClient(i.hosts[0]);
    hostId = i.hosts[0].id;
  });

  afterAll(async () => {
    // Leave the row clean for re-runs / other suites.
    if (host && hostId) await host.from("profiles").update({ username: null }).eq("id", hostId);
  });

  it.skipIf(!dbReady)("setting a previously-empty username writes the non-null value", async () => {
    if (!host) return;
    const uname = "task7_h19_set";
    // Clean slate via the host's own row (RLS allows own-row updates).
    await host.from("profiles").update({ username: null }).eq("id", hostId);

    const { data, error } = await host
      .from("profiles")
      .update({ username: uname })
      .eq("id", hostId)
      .select("username");
    expect(error, "setting a username succeeds").toBeNull();
    expect(data?.[0]?.username, "the non-null username is persisted").toBe(uname);
  });

  it.skipIf(!dbReady)("changing an existing username to another non-null value still goes through", async () => {
    if (!host) return;
    const next = "task7_h19_changed";
    const { data, error } = await host
      .from("profiles")
      .update({ username: next })
      .eq("id", hostId)
      .select("username");
    expect(error, "changing a username succeeds (no guard interference)").toBeNull();
    expect(data?.[0]?.username, "the changed username is persisted").toBe(next);
  });
});
