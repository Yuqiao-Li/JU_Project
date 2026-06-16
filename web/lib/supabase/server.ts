import { cookies } from "next/headers";

import { createServerClient } from "@supabase/ssr";

import { supabaseAnonKey, supabaseUrl } from "./env";

/**
 * Server-side (anon-key) Supabase client for Server Components, Server Actions
 * and Route Handlers. Wires Supabase Auth to Next.js request cookies so a
 * logged-in HOST's session is available server-side (`auth.uid()`).
 *
 * Still the anon key: host authorization is enforced by RLS keyed on
 * `auth.uid() = events.host_id`, not by this client. For trusted/private reads
 * use `service.ts` instead.
 *
 * `cookies()` is async in this Next.js version, so this factory is async.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // In a Server Component render, setting cookies throws — Next.js only
        // allows it in Server Actions / Route Handlers. Swallow it there;
        // session refresh is handled by middleware/route handlers instead.
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component; safe to ignore.
        }
      },
    },
  });
}
