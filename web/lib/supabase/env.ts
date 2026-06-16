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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `See web/env.local.example and set it in web/.env.local.`,
    );
  }
  return value;
}

/** Public Supabase project URL (safe for the browser). */
export function supabaseUrl(): string {
  return requireEnv("NEXT_PUBLIC_SUPABASE_URL");
}

/** Public anon key — the only Supabase key that may reach the client. */
export function supabaseAnonKey(): string {
  return requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

/**
 * Service-role key — TRUSTED. Must only be read on the server (`service.ts`
 * imports `server-only`). Intentionally NOT a `NEXT_PUBLIC_` variable.
 */
export function supabaseServiceRoleKey(): string {
  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}
