import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * Proxy (Next 16's renamed middleware) — refreshes the Supabase auth session on
 * every navigation so Server Components see a fresh `auth.uid()`, and guards the
 * host-only `/dashboard` area.
 *
 * This is a UX gate, NOT the security boundary: the authority is RLS
 * (auth.uid() = host_id) plus per-page `getUser()` checks. Per Next's own
 * guidance, never rely on the proxy alone — every guarded page re-checks.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates the JWT against the auth server (don't trust the
  // unverified session in a gate).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = path === "/dashboard" || path.startsWith("/dashboard/");
  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Remember where they were headed so login can bounce them back.
    url.search = "";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Run on everything except static assets and image files. Auth code paths
  // (/auth/*) are included so their cookies refresh too.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
