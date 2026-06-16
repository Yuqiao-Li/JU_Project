import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { supabaseServiceRoleKey, supabaseUrl } from "./env";

/**
 * Trusted (service-role) Supabase client. SERVER-ONLY.
 *
 * The `server-only` import above makes any attempt to import this module from a
 * Client Component a build error — a hard guarantee that the service-role key
 * never reaches the browser bundle (defence-in-depth alongside the env layer
 * and check-boundaries.sh).
 *
 * Use this ONLY for trusted paths the security model designates for the
 * service role, e.g. SSR reads of private events via `get_event_by_slug`
 * (SCHEMA.md D3). This client bypasses RLS — never expose its results to a
 * client without re-applying the field-tiering the RPCs enforce.
 *
 * No session is persisted: it must never pick up or mutate a user session.
 */
export function createServiceClient() {
  return createSupabaseClient(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
