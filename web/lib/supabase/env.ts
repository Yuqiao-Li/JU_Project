/**
 * Centralised, lazily-read Supabase environment access.
 *
 * Reads are performed inside functions (never at module top-level) so that
 * importing a client helper never throws during `next build`, which runs
 * without secrets present. Missing values fail loudly only when a client is
 * actually constructed at request time.
 *
 * Security boundary (CLAUDE.md / SCHEMA.md):
 * - The URL and the anon key are public and may reach the browser.
 * - The service-role key is a trusted credential. It is read from a
 *   NON-`NEXT_PUBLIC_` variable so it can never be inlined into client
 *   bundles, and it is only ever read by the server-only `service.ts`.
 */

function missing(name: string): never {
  throw new Error(
    `Missing required environment variable: ${name}. ` +
      `See web/env.local.example and set it in web/.env.local.`,
  );
}

/**
 * Public Supabase project URL (safe for the browser).
 *
 * IMPORTANT: this MUST be a LITERAL `process.env.NEXT_PUBLIC_…` reference. Next
 * only inlines NEXT_PUBLIC_ vars into the client bundle when accessed statically;
 * a dynamic `process.env[name]` read is NOT inlined, so it is `undefined` in the
 * browser even when the var is set — which breaks the browser Supabase client.
 */
export function supabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || missing("NEXT_PUBLIC_SUPABASE_URL");
}

/** Public anon key — the only Supabase key that may reach the client. Literal access (see above). */
export function supabaseAnonKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || missing("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

/**
 * Service-role key — TRUSTED. Must only be read on the server (`service.ts`
 * imports `server-only`). Intentionally NOT a `NEXT_PUBLIC_` variable, so it is
 * never inlined into a client bundle; read at runtime on the server.
 */
export function supabaseServiceRoleKey(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || missing("SUPABASE_SERVICE_ROLE_KEY");
}
