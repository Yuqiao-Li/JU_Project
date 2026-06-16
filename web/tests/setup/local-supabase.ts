import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { WEB_DIR } from "./load-env";

// tests/setup -> tests -> web -> repo root (where supabase/config.toml lives).
const REPO_ROOT = resolve(WEB_DIR, "..");

/** Connection details for the LOCAL supabase stack (`supabase status -o env`). */
export interface LocalSupabaseConfig {
  /** PostgREST/GoTrue API gateway, e.g. http://127.0.0.1:54321. */
  apiUrl: string;
  /** Public anon key (local demo key — not a secret, never committed). */
  anonKey: string;
  /** Service-role key (trusted path; test-process only). */
  serviceRoleKey: string;
  /** Direct Postgres connection string for migrations/db reset. */
  dbUrl: string;
}

/** Parse `KEY="value"` lines from `supabase status -o env`, ignoring banners. */
function parseStatusEnv(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of output.split("\n")) {
    const match = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(rawLine.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/**
 * Read the running local stack's config. Returns null when the supabase CLI is
 * missing or the stack isn't up (`supabase status` exits non-zero) — callers
 * then skip rather than fail, so `pnpm test` stays green without Docker.
 */
function readStatus(): Record<string, string> | null {
  try {
    const output = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      encoding: "utf8",
    });
    return parseStatusEnv(output);
  } catch {
    return null;
  }
}

function toConfig(env: Record<string, string>): LocalSupabaseConfig | null {
  const apiUrl = env.API_URL;
  const anonKey = env.ANON_KEY;
  const serviceRoleKey = env.SERVICE_ROLE_KEY;
  const dbUrl = env.DB_URL;
  if (!apiUrl || !anonKey || !serviceRoleKey || !dbUrl) return null;
  return { apiUrl, anonKey, serviceRoleKey, dbUrl };
}

/**
 * True when the local stack answers `supabase status`. Used to gate the 0.6
 * provisioning assertions: present here, so we demand real provisioning; absent
 * (e.g. CI without Docker), so the assertions skip instead of failing.
 */
export function localStackRunning(): boolean {
  return readStatus() !== null;
}

/**
 * Resolve the LOCAL supabase stack for the test harness (task 0.6).
 *
 * Tests ALWAYS run against the local Docker stack — never a remote project —
 * because the suite resets the DB and runs concurrency scenarios (CLAUDE.md /
 * TASKS 0.6: 不依赖远端云库做并发测试). If the stack isn't up yet and
 * `autoStart` is enabled, best-effort `supabase start` then retry once.
 *
 * Returns null when no local stack can be reached, leaving the caller to fall
 * back to env-var config (and skip DB-dependent tests).
 */
export function resolveLocalSupabase(opts?: { autoStart?: boolean }): LocalSupabaseConfig | null {
  let env = readStatus();
  if (!env && (opts?.autoStart ?? true)) {
    try {
      // First start may pull images; generous bound. Idempotent if already up.
      execFileSync("supabase", ["start"], {
        cwd: REPO_ROOT,
        stdio: "ignore",
        timeout: 300_000,
      });
    } catch {
      return null;
    }
    env = readStatus();
  }
  return env ? toConfig(env) : null;
}
