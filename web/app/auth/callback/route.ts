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
 */
const ALLOWED_OTP_TYPES: ReadonlySet<string> = new Set([
  "email",
  "magiclink",
  "signup",
  "recovery",
  "invite",
  "email_change",
]);

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get("next"));
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  } else if (tokenHash && type && ALLOWED_OTP_TYPES.has(type)) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
