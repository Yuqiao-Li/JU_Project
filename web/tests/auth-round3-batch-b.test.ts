import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * ROUND-3 BATCH B — SOURCE / CONFIG ASSERTION GUARDS for three auth improvements.
 *
 * WHY SOURCE-ASSERTED (not behavioral): the whole auth flow is unrenderable /
 * unexecutable under this vitest harness (`environment:"node"`, `include:["tests/**\/*.test.ts"]`).
 * The pieces are a CLIENT component (`login-form.tsx`, needs a browser + Supabase
 * cookies), a Next.js route handler (`auth/callback/route.ts`), an `async` Server
 * Component page (`auth/signed-in/page.tsx`, uses server-only `getTranslations`), a
 * STATIC email template (`supabase/templates/magic_link.html`), and a Supabase CLI
 * config file (`supabase/config.toml`). None of those run here. So we lock the
 * invariants in with the same comment-stripped SOURCE-GREP style used by
 * `client-tree-no-server-getTranslations.test.ts`, plus an i18n-parity check.
 *
 * What shipped (the invariants these tests pin):
 *   #1 Original-tab redirect + interstitial — login-form polls getSession in the
 *      "sent" state and full-navigates the original tab; the magic-link callback URL
 *      carries `flow=email` so the link-opened tab lands on /auth/signed-in (Google
 *      OAuth is NOT tagged → it bypasses the interstitial).
 *   #2 OTP — login-form has a 6-digit verifyOtp({ type: "email" }) path.
 *   #3 Email template — branded supabase/templates/magic_link.html wired via
 *      [auth.email.template.magic_link] in supabase/config.toml.
 *
 * NOTE on comment-stripping: several of these files NAME the tokens we grep for in
 * their own prose (e.g. the callback route's doc comment says "flow=email"). A naive
 * substring grep would self-trip on that. So we strip block + line comments and match
 * against CODE only. Greps are kept tolerant of whitespace/quotes so honest refactors
 * don't false-fail.
 *
 * NOTE on paths: `magic_link.html` and `config.toml` live OUTSIDE `web/`, under the
 * repo root `supabase/`. We resolve those relative to the repo root (../../ from
 * web/tests/), with a sanity assertion that each file exists so a moved file can't
 * silently pass.
 */

/** Read a file under `web/` by web-relative path (relative to this test file's dir). */
function webSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

/** Resolve a path relative to the REPO ROOT (two levels up from web/tests/). */
function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../${rel}`, import.meta.url));
}

/** Read a file by repo-root-relative path. */
function repoSrc(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}

/** Strip `/* … *\/` block comments and `// …` line comments so we grep CODE, not prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep the char before "//", avoids eating "https://")
}

// ── GROUP A: login-form.tsx (client) ────────────────────────────────────────────
describe("BATCH B #1/#2 — login-form.tsx locks in the cross-tab redirect + OTP", () => {
  const RAW = webSrc("components/auth/login-form.tsx");
  const CODE = stripComments(RAW);

  it("is a client component (\"use client\") — it polls + full-navigates in the browser", () => {
    expect(/^["']use client["'];?/m.test(RAW), "login-form.tsx: \"use client\" present").toBe(true);
  });

  it("cross-tab session poll: references getSession + setInterval + a window.location full nav", () => {
    expect(/\bgetSession\b/.test(CODE), "login-form: polls getSession").toBe(true);
    expect(/\bsetInterval\b/.test(CODE), "login-form: uses setInterval to poll").toBe(true);
    // Full navigation (not router.push) so the server reads the freshly-set auth cookies.
    expect(/window\s*\.\s*location/.test(CODE), "login-form: redirects via window.location").toBe(true);
  });

  it("OTP path: verifyOtp({ type: \"email\" })", () => {
    expect(/\bverifyOtp\b/.test(CODE), "login-form: calls verifyOtp").toBe(true);
    // Tolerant of `type: "email"` / `type:"email"` / single quotes.
    expect(/type\s*:\s*["']email["']/.test(CODE), "login-form: verifyOtp uses type: \"email\"").toBe(true);
  });

  it("flow=email marker tags the magic-link/OTP send; Google OAuth still exists (untagged)", () => {
    // The `flow` marker is set to "email" on the callback URL. The impl builds it
    // programmatically (callbackUrl("email") → params.set("flow", flow)) rather than
    // hardcoding the literal "flow=email", so we assert the construction tolerantly:
    //   (a) a `flow` query param is set, AND
    //   (b) the email-send call site passes the "email" flow value.
    const setsFlowParam = /\.\s*set\s*\(\s*["']flow["']/.test(CODE) || CODE.includes("flow=email");
    expect(setsFlowParam, "login-form: tags the callback URL with a `flow` param").toBe(true);
    // The email send is identifiable by its emailRedirectTo option, and that redirect
    // is the one carrying the email flow marker.
    expect(/\bemailRedirectTo\b/.test(CODE), "login-form: email send sets emailRedirectTo").toBe(true);
    // The "email" flow value reaches the callback-URL builder (e.g. callbackUrl("email")).
    expect(
      /callbackUrl\s*\(\s*["']email["']\s*\)/.test(CODE) || CODE.includes("flow=email"),
      "login-form: the email send tags the callback with the \"email\" flow",
    ).toBe(true);
    // Google OAuth path still exists (it must NOT be removed by the interstitial work)
    // and it builds the callback WITHOUT a flow value (untagged → bypasses interstitial).
    expect(/\bsignInWithOAuth\b/.test(CODE), "login-form: Google OAuth (signInWithOAuth) still present").toBe(true);
    expect(
      /callbackUrl\s*\(\s*\)/.test(CODE),
      "login-form: OAuth builds an untagged callback (callbackUrl() with no flow)",
    ).toBe(true);
  });

  it("guards the redirect to fire once (a ref/flag near the full nav)", () => {
    // Loose: a useRef OR a boolean guard exists. Don't over-pin to a variable name.
    const hasRef = /\buseRef\b/.test(CODE);
    const hasFlagGuard = /redirected|hasRedirected|alreadyRedirected|didRedirect/i.test(CODE);
    expect(hasRef || hasFlagGuard, "login-form: a once-only guard (useRef or boolean flag) exists").toBe(true);
  });
});

// ── GROUP B: auth/callback/route.ts ──────────────────────────────────────────────
describe("BATCH B #1 — callback/route.ts routes the email flow to the interstitial", () => {
  const RAW = webSrc("app/auth/callback/route.ts");
  const CODE = stripComments(RAW);

  it("reads `flow` from searchParams and compares it === \"email\"", () => {
    // searchParams.get("flow") (tolerant of quotes/spacing).
    expect(
      /searchParams\s*\.\s*get\s*\(\s*["']flow["']\s*\)/.test(CODE),
      "callback: reads flow from searchParams",
    ).toBe(true);
    expect(/===\s*["']email["']/.test(CODE), "callback: compares the flow === \"email\"").toBe(true);
  });

  it("the email branch redirects to /auth/signed-in", () => {
    expect(CODE.includes("/auth/signed-in"), "callback: email flow → /auth/signed-in").toBe(true);
  });

  it("the non-email branch still redirects to `${origin}${next}` (both branches exist)", () => {
    // Tolerant of spacing inside the template literal.
    expect(
      /\$\{\s*origin\s*\}\s*\$\{\s*next\s*\}/.test(CODE),
      "callback: non-email flow → ${origin}${next}",
    ).toBe(true);
  });
});

// ── GROUP C: auth/signed-in/page.tsx ─────────────────────────────────────────────
describe("BATCH B #1 — signed-in interstitial sanitizes `next` and links to it", () => {
  const REL = "app/auth/signed-in/page.tsx";

  it("the page file exists (a moved/renamed file can't silently pass)", () => {
    expect(
      existsSync(fileURLToPath(new URL(`../${REL}`, import.meta.url))),
      "web/app/auth/signed-in/page.tsx exists",
    ).toBe(true);
  });

  it("sanitizes the `next` param via safeNext and links the CTA to it", () => {
    const CODE = stripComments(webSrc(REL));
    expect(/\bsafeNext\b/.test(CODE), "signed-in: sanitizes next with safeNext").toBe(true);
    // The "continue" CTA links to the sanitized next (a Link/href).
    expect(/\bhref\b/.test(CODE), "signed-in: renders a link (href) to continue").toBe(true);
  });
});

// ── GROUP D: email template + config wiring ──────────────────────────────────────
describe("BATCH B #3 — branded magic_link.html + config.toml wiring", () => {
  const TEMPLATE_REL = "supabase/templates/magic_link.html";
  const CONFIG_REL = "supabase/config.toml";

  it("the template + config files exist at the repo root (outside web/)", () => {
    expect(existsSync(repoPath(TEMPLATE_REL)), `${TEMPLATE_REL} exists at repo root`).toBe(true);
    expect(existsSync(repoPath(CONFIG_REL)), `${CONFIG_REL} exists at repo root`).toBe(true);
  });

  it("magic_link.html carries BOTH Supabase vars {{ .ConfirmationURL }} and {{ .Token }}", () => {
    const html = repoSrc(TEMPLATE_REL);
    // Tolerant of arbitrary whitespace inside the braces.
    expect(/\{\{\s*\.ConfirmationURL\s*\}\}/.test(html), "template: has {{ .ConfirmationURL }}").toBe(true);
    expect(/\{\{\s*\.Token\s*\}\}/.test(html), "template: has {{ .Token }} (the 6-digit code)").toBe(true);
  });

  it("magic_link.html shows JU branding", () => {
    const html = repoSrc(TEMPLATE_REL);
    expect(html.includes("JU"), "template: JU branding present").toBe(true);
  });

  it("config.toml has [auth.email.template.magic_link] pointing content_path at magic_link.html", () => {
    const toml = repoSrc(CONFIG_REL);
    expect(
      /\[\s*auth\.email\.template\.magic_link\s*\]/.test(toml),
      "config: [auth.email.template.magic_link] section present",
    ).toBe(true);
    // content_path = "...magic_link.html" (tolerant of spacing/path prefix).
    expect(
      /content_path\s*=\s*["'][^"']*magic_link\.html["']/.test(toml),
      "config: content_path points at magic_link.html",
    ).toBe(true);
  });
});

// ── GROUP E: i18n parity for the auth namespace ──────────────────────────────────
describe("BATCH B — i18n parity: auth namespace identical across zh/en + 8 new keys present", () => {
  const zh = JSON.parse(webSrc("messages/zh.json")) as Record<string, Record<string, unknown>>;
  const en = JSON.parse(webSrc("messages/en.json")) as Record<string, Record<string, unknown>>;

  const NEW_KEYS = [
    "otpLabel",
    "otpPlaceholder",
    "verifyCode",
    "verifying",
    "otpError",
    "signedInTitle",
    "signedInBody",
    "signedInCta",
  ] as const;

  it("both locales define an `auth` namespace", () => {
    expect(zh.auth, "zh.json has an auth namespace").toBeTypeOf("object");
    expect(en.auth, "en.json has an auth namespace").toBeTypeOf("object");
  });

  it("the auth key SETS are identical across zh and en", () => {
    const zhKeys = Object.keys(zh.auth).sort();
    const enKeys = Object.keys(en.auth).sort();
    expect(zhKeys, "auth namespace key sets match between zh and en").toEqual(enKeys);
  });

  it.each(NEW_KEYS)("the new key %s is present and NON-EMPTY in BOTH locales", (key) => {
    const zhVal = zh.auth[key];
    const enVal = en.auth[key];
    expect(typeof zhVal, `zh.auth.${key} is a string`).toBe("string");
    expect(typeof enVal, `en.auth.${key} is a string`).toBe("string");
    expect((zhVal as string).trim().length, `zh.auth.${key} non-empty`).toBeGreaterThan(0);
    expect((enVal as string).trim().length, `en.auth.${key} non-empty`).toBeGreaterThan(0);
  });
});
