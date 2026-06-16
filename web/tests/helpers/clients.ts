import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inject } from "vitest";

import type { TestHost, TestInfra } from "../setup/infra";

/** The test infrastructure provided by the global setup. */
export function infra(): TestInfra {
  return inject("infra");
}

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } } as const;

function requireConfig(): { url: string; anonKey: string; serviceRoleKey: string } {
  const i = infra();
  if (!i.supabaseUrl || !i.anonKey || !i.serviceRoleKey) {
    throw new Error(i.skipReason ?? "Supabase test env not configured");
  }
  return { url: i.supabaseUrl, anonKey: i.anonKey, serviceRoleKey: i.serviceRoleKey };
}

/** Anon (guest/public) path — public anon key, no session. */
export function anonClient(): SupabaseClient {
  const { url, anonKey } = requireConfig();
  return createClient(url, anonKey, NO_SESSION);
}

/** Host path — authenticated as `host` via its minted session JWT. */
export function hostClient(host: TestHost): SupabaseClient {
  const { url, anonKey } = requireConfig();
  return createClient(url, anonKey, {
    ...NO_SESSION,
    global: { headers: { Authorization: `Bearer ${host.accessToken}` } },
  });
}

/** Trusted path — service role, bypasses RLS. Server/test only. */
export function serviceClient(): SupabaseClient {
  const { url, serviceRoleKey } = requireConfig();
  return createClient(url, serviceRoleKey, NO_SESSION);
}
