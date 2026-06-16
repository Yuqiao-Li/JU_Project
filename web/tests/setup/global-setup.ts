import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { TestProject } from "vitest/node";

import type { TestHost, TestInfra } from "./infra";
import { loadTestEnv, WEB_DIR } from "./load-env";

const REPO_ROOT = resolve(WEB_DIR, "..");

// Fixed local test users (not secrets). Confirmed + signed in by the setup.
const HOST_PASSWORD = "test-host-password-9f3a2c";
const HOST_EMAILS = ["host-a.test@partiful.local", "host-b.test@partiful.local"];

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function log(message: string): void {
  // Surfaced in the orchestrator log so it's clear why DB tests ran or skipped.
  console.info(`[test global-setup] ${message}`);
}

/**
 * Best-effort `supabase db reset` (applies all migrations + seed). Skipped until
 * the Supabase project is provisioned (config.toml lands in tasks 0.5/0.6); a
 * failure never aborts the run — DB-dependent tests will simply skip.
 */
function tryDbReset(): string {
  if (!existsSync(resolve(REPO_ROOT, "supabase", "config.toml"))) {
    return "skipped supabase db reset (no supabase/config.toml yet — provisioned in tasks 0.5/0.6)";
  }
  try {
    execFileSync("supabase", ["db", "reset"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });
    return "supabase db reset applied (migrations + seed)";
  } catch (err) {
    return `supabase db reset failed (continuing): ${errMessage(err)}`;
  }
}

async function findUserByEmail(admin: SupabaseClient, email: string): Promise<User | null> {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

/** Create (idempotently) a confirmed host user and mint a session for it. */
async function ensureHost(
  admin: SupabaseClient,
  signer: SupabaseClient,
  email: string,
): Promise<TestHost> {
  const existing = await findUserByEmail(admin, email);
  if (existing) await admin.auth.admin.deleteUser(existing.id);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: HOST_PASSWORD,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw createErr ?? new Error(`createUser returned no user for ${email}`);
  }

  const { data: signed, error: signErr } = await signer.auth.signInWithPassword({
    email,
    password: HOST_PASSWORD,
  });
  if (signErr || !signed.session) {
    throw signErr ?? new Error(`signInWithPassword returned no session for ${email}`);
  }

  return {
    id: created.user.id,
    email,
    password: HOST_PASSWORD,
    accessToken: signed.session.access_token,
    refreshToken: signed.session.refresh_token,
  };
}

export default async function setup({ provide }: TestProject) {
  loadTestEnv();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;

  const base: TestInfra = {
    dbReady: false,
    supabaseUrl,
    anonKey,
    serviceRoleKey,
    hosts: [],
    skipReason: null,
  };

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    const skipReason =
      "Supabase env not configured (need NEXT_PUBLIC_SUPABASE_URL, " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY) — DB-dependent tests skipped.";
    provide("infra", { ...base, skipReason });
    log(skipReason);
    return;
  }

  log(tryDbReset());

  const noSession = { auth: { persistSession: false, autoRefreshToken: false } } as const;
  const admin = createClient(supabaseUrl, serviceRoleKey, noSession);
  const signer = createClient(supabaseUrl, anonKey, noSession);

  let hosts: TestHost[];
  try {
    hosts = [];
    for (const email of HOST_EMAILS) {
      hosts.push(await ensureHost(admin, signer, email));
    }
  } catch (err) {
    const skipReason = `Supabase auth unreachable (continuing): ${errMessage(err)} — DB-dependent tests skipped.`;
    provide("infra", { ...base, skipReason });
    log(skipReason);
    return;
  }

  provide("infra", { ...base, dbReady: true, hosts });
  log(`ready: ${hosts.length} confirmed host sessions minted.`);

  return async () => {
    for (const host of hosts) {
      try {
        await admin.auth.admin.deleteUser(host.id);
      } catch {
        // best-effort cleanup
      }
    }
  };
}
