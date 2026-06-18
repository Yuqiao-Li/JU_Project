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

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get("next"));
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

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
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    console.error(`[auth/callback] code exchange failed: ${error.message}`);
    return errorRedirect(origin, "expired");
  } else if (tokenHash && type && ALLOWED_OTP_TYPES.has(type)) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    console.error(`[auth/callback] OTP verify failed: ${error.message}`);
    return errorRedirect(origin, "expired");
  }

  // No code, no token, no error param — a malformed/old callback link.
  return errorRedirect(origin, "expired");
}
