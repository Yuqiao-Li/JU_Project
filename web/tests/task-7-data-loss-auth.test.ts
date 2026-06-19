import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
 *   H19 — (RETIRED by Step-10A task 7) the username-clear data-loss guard pinned the
 *         settings form's public-username field + its clear-confirm flow + the
 *         USERNAME_CLEAR_UNCONFIRMED server sentinel. The public-username handle is
 *         retired (入口是局不是人, §5): the single name field IS the nickname
 *         (display_name); username is no longer surfaced/edited. The clear-confirm UI
 *         and sentinel are intentionally GONE, so those assertions are removed. In
 *         their place we pin the new settings contract (see "Step-10A task 7" block):
 *         updateProfile writes profiles.contact and the form is a single nickname.
 *   H20 — assume a transient RPC/fetch error collapses into the cheerful empty
 *         state ("No events yet"), hiding real events. The reader must THROW on a
 *         genuine error (route boundary → retry) yet still degrade a null/empty
 *         payload (no error) to [] (D2 no-existence-oracle).
 *
 * The React client + Next server actions can't be rendered/imported under vitest
 * (`"use client"` / `"use server"` / `@/`-alias / next/cache / window), so those
 * invariants are pinned on the SOURCE TEXT — the same static-guard posture the
 * task-4 lifecycle suite uses.
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
// Step-10A task 7 — settings simplification (REPLACES the retired H19 block).
//
// The public-username handle + its availability check + the clear-confirm
// data-loss flow are retired (入口是局不是人, §5). The single name field IS the
// host's nickname (display_name), and the host now owns a general `contact`
// (profiles.contact), revealed to guests only AFTER the event finalizes
// (double-blind, via get_event_by_slug). The DB `username` column is KEPT but no
// longer surfaced/edited here. These pin the new settings contract on the SOURCE
// TEXT (server action / server component / client form can't run under vitest).
// ─────────────────────────────────────────────────────────────────────────────

describe("Step-10A task 7: the settings form is a single nickname (display_name), username UI gone", () => {
  it("the nickname field IS display_name — a required text input wired to the display_name name/id", () => {
    // The one name field maps to display_name (the nickname), not a separate handle.
    expect(
      /name="display_name"/.test(PROFILE_FORM),
      "profile-form: a single name input named display_name",
    ).toBe(true);
    expect(
      /id="display_name"/.test(PROFILE_FORM),
      "profile-form: the nickname input is id=display_name",
    ).toBe(true);
    // It is the nickname: labelled via the nicknameLabel key, and required.
    expect(
      /t\(\s*["']nicknameLabel["']\s*\)/.test(PROFILE_FORM),
      "profile-form: the field is labelled as the nickname (nicknameLabel)",
    ).toBe(true);
    // The display name is rendered required so the host always has a recognizable name.
    expect(
      /id="display_name"[\s\S]{0,200}\brequired\b/.test(PROFILE_FORM),
      "profile-form: the nickname input is required",
    ).toBe(true);
  });

  it("the retired public-username UI is gone — no username input, availability check, or clear-confirm flow", () => {
    // No separate username handle input.
    expect(/id="username"/.test(PROFILE_FORM), "profile-form: no username input remains").toBe(false);
    expect(
      /name="username"/.test(PROFILE_FORM),
      "profile-form: no username form field remains",
    ).toBe(false);
    // No live availability check / username-check route call.
    expect(
      /username-check/.test(PROFILE_FORM),
      "profile-form: no availability-check call remains",
    ).toBe(false);
    // No clear-confirm data-loss flow (the retired H19 mechanism).
    expect(
      /confirm_clear|confirmedClear|clearingUsername|USERNAME_CLEAR_UNCONFIRMED/.test(PROFILE_FORM),
      "profile-form: no username clear-confirm flow remains",
    ).toBe(false);
    // No /u/ public-handle reference in the form copy.
    expect(/\/u\//.test(PROFILE_FORM), "profile-form: no /u/<handle> reference remains").toBe(false);
  });

  it("the server action no longer carries the retired username-clear guard or writes username", () => {
    expect(
      /USERNAME_CLEAR_UNCONFIRMED/.test(SETTINGS_ACTIONS),
      "actions: the retired clear-confirm sentinel is gone",
    ).toBe(false);
    expect(
      /confirm_clear/.test(SETTINGS_ACTIONS),
      "actions: the action no longer reads confirm_clear",
    ).toBe(false);
    // The UPDATE must NOT set the username column anymore (kept in DB, not edited here).
    expect(
      /\.update\(\s*\{[^}]*\busername\b/.test(SETTINGS_ACTIONS),
      "actions: the profiles UPDATE no longer writes the username column",
    ).toBe(false);
  });
});

describe("Step-10A task 7: updateProfile writes profiles.contact (host's general contact)", () => {
  it("the form exposes a general contact input wired to the `contact` field", () => {
    expect(/name="contact"/.test(PROFILE_FORM), "profile-form: a contact input named contact").toBe(
      true,
    );
    expect(/id="contact"/.test(PROFILE_FORM), "profile-form: the contact input is id=contact").toBe(
      true,
    );
    // It is the host's general contact — labelled via the contactLabel key.
    expect(
      /t\(\s*["']contactLabel["']\s*\)/.test(PROFILE_FORM),
      "profile-form: the contact field is labelled (contactLabel)",
    ).toBe(true);
  });

  it("the server action reads the `contact` form value and persists it on the profiles UPDATE", () => {
    // The action must pull `contact` off the FormData…
    expect(
      /formData\.get\(\s*["']contact["']\s*\)/.test(SETTINGS_ACTIONS),
      "actions: reads the contact form value",
    ).toBe(true);
    // …and include `contact` in the columns it writes to the caller's own profiles row.
    expect(
      /\.update\(\s*\{[\s\S]*?\bcontact\b[\s\S]*?\}\s*\)/.test(SETTINGS_ACTIONS),
      "actions: the profiles UPDATE includes the contact column",
    ).toBe(true);
    // The UPDATE is scoped to the caller's own row (id = auth.uid()), never a client id.
    expect(
      /\.update\([\s\S]*?\)\s*\.eq\(\s*["']id["']\s*,\s*user\.id\s*\)/.test(SETTINGS_ACTIONS),
      "actions: the UPDATE is scoped to .eq('id', user.id) (own row only)",
    ).toBe(true);
  });

  it("an empty contact clears it (null), and a too-long contact is rejected at the boundary", () => {
    // Empty input clears the stored value to null rather than writing "".
    expect(
      /rawContact\.length\s*>\s*0\s*\?\s*rawContact\s*:\s*null/.test(SETTINGS_ACTIONS) ||
        /contact[\s\S]{0,60}length\s*>\s*0[\s\S]{0,20}:\s*null/.test(SETTINGS_ACTIONS),
      "actions: an empty contact is stored as null",
    ).toBe(true);
    // A bounded-length guard rejects an over-long contact before the write.
    expect(
      /rawContact\.length\s*>\s*\d+/.test(SETTINGS_ACTIONS),
      "actions: a length bound guards the contact value",
    ).toBe(true);
  });

  it("the settings catalogs carry the nickname + contact keys in BOTH locales (no missing-key fallback)", () => {
    for (const [name, cat] of [["en", EN], ["zh", ZH]] as const) {
      for (const key of ["nicknameLabel", "contactLabel", "contactPlaceholder", "contactHint"] as const) {
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
