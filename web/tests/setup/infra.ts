/**
 * Shared shape of the test infrastructure produced by the global setup and
 * handed to tests via Vitest's `provide`/`inject` channel.
 */

/** A confirmed host user with a live session minted by the global setup. */
export interface TestHost {
  id: string;
  email: string;
  /** Plain test password (local test users only — never a real credential). */
  password: string;
  /** JWT for the host (authenticated) read/write path. */
  accessToken: string;
  refreshToken: string;
}

export interface TestInfra {
  /**
   * True only when a live Supabase test DB + auth were reachable AND >=2
   * confirmed host sessions were minted. DB-dependent tests `skipIf(!dbReady)`.
   */
  dbReady: boolean;
  supabaseUrl: string | null;
  /** Public anon key — the anon (guest/public) client path. */
  anonKey: string | null;
  /** Service-role key — the trusted server path. Test-process only. */
  serviceRoleKey: string | null;
  /** Confirmed host users with live sessions (empty when `dbReady` is false). */
  hosts: TestHost[];
  /** Human-readable reason when `dbReady` is false. */
  skipReason: string | null;
}

// Type the provide/inject channel so `inject("infra")` is fully typed.
declare module "vitest" {
  interface ProvidedContext {
    infra: TestInfra;
  }
}
