import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/types/database";

import { supabaseAnonKey, supabaseUrl } from "./env";

/**
 * Browser (anon) Supabase client for use in Client Components.
 *
 * Uses only the public URL + anon key. Per the project constitution, the anon
 * role has NO direct read/write on guest-data tables — all guest-facing access
 * goes through SECURITY DEFINER RPCs. This client is the public, forgeable
 * surface; never trust it for authorization.
 */
export function createClient() {
  return createBrowserClient<Database>(supabaseUrl(), supabaseAnonKey());
}
