import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { safeNext } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback — completes sign-in for both flows the login form can trigger:
 *   • OAuth (Google) and PKCE magic links arrive with `?code=` → exchange it.
 *   • Email OTP / magic links arrive with `?token_hash=&type=` → verify it.
 *
 * On success we land on the (sanitized) `next` path; otherwise the error page.
 * Cookies are written by the server client through the route handler response.
 *
 * When a provider rejects or the user cancels, Supabase / the OAuth provider
 * redirect back here with `?error=&error_description=&error_code=` (often with NO
 * `code`). We read those, log the description server-side, and forward a coarse
 * `reason` to the error page so it can show the right message (cancelled vs
 * expired vs server error) instead of the generic "link expired" copy (H21).
 */
const ALLOWED_OTP_TYPES: ReadonlySet<string> = new Set([
  "email",
  "magiclink",
  "signup",
  "recovery",
  "invite",
  "email_change",
]);

/** Map provider/OTP error codes to a coarse reason the error page localizes. */
function classifyAuthError(error: string, errorCode: string | null): "cancelled" | "expired" | "server" {
  const e = error.toLowerCase();
  const code = (errorCode ?? "").toLowerCase();
  if (e === "access_denied" || code === "access_denied") return "cancelled";
  if (code === "otp_expired" || e.includes("expired")) return "expired";
  return "server";
}

function errorRedirect(origin: string, reason: string): NextResponse {
  const params = new URLSearchParams({ reason });
  return NextResponse.redirect(`${origin}/auth/auth-code-error?${params.toString()}`);
}

/**
 * Where to land after a successful sign-in. Email magic links open a NEW tab, so
 * they go to the "you're signed in" interstitial (the original tab redirects
 * itself once it detects the session). Google OAuth is a same-tab redirect, so it
 * goes straight to `next`. We distinguish them via the `flow=email` marker the
 * login form adds to the magic-link callback URL; the `token_hash` OTP branch is
 * always an email link, so it always uses the interstitial.
 */
function successRedirect(origin: string, next: string, isEmail: boolean): NextResponse {
  if (isEmail) {
    return NextResponse.redirect(`${origin}/auth/signed-in?next=${encodeURIComponent(next)}`);
  }
  return NextResponse.redirect(`${origin}${next}`);
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get("next"));
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  // The login form tags email magic links with `flow=email`; OAuth omits it.
  const isEmailFlow = searchParams.get("flow") === "email";

  // Provider/OTP errors come back as query params, frequently without a `code`.
  const providerError = searchParams.get("error");
  const errorCode = searchParams.get("error_code");
  const errorDescription = searchParams.get("error_description");
  if (providerError) {
    // Server-side diagnostics — never surfaced raw to the page.
    console.error(
      `[auth/callback] provider error: ${providerError}` +
        (errorCode ? ` (code: ${errorCode})` : "") +
        (errorDescription ? ` — ${errorDescription}` : ""),
    );
    return errorRedirect(origin, classifyAuthError(providerError, errorCode));
  }

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // `code` covers both OAuth and PKCE magic links; `flow=email` tells them apart.
    if (!error) return successRedirect(origin, next, isEmailFlow);
    console.error(`[auth/callback] code exchange failed: ${error.message}`);
    return errorRedirect(origin, "expired");
  } else if (tokenHash && type && ALLOWED_OTP_TYPES.has(type)) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    // A token_hash link is always email → always use the interstitial.
    if (!error) return successRedirect(origin, next, true);
    console.error(`[auth/callback] OTP verify failed: ${error.message}`);
    return errorRedirect(origin, "expired");
  }

  // No code, no token, no error param — a malformed/old callback link.
  return errorRedirect(origin, "expired");
}
