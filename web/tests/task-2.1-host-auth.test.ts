import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { anonClient, hostClient, infra, serviceClient } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 2.1 — host authentication (integration, admin/host/anon sessions).
 *
 * The frontend auth (magic link + Google, /dashboard guard) leans on three DB
 * guarantees the constitution makes non-negotiable. These are the task's
 * 【测试】 assertions, written adversarially:
 *
 *   1. A first sign-in auto-creates the host's `profiles` row via the auth.users
 *      trigger — NOT a client upsert (D7④; client never sends profiles.id).
 *   2. A client can never write a profiles row it doesn't own (RLS id=auth.uid()
 *      + no INSERT grant) — so "client 不得传 profiles.id" holds at the DB.
 *   3. Username uniqueness is enforced by the DB unique index even under a
 *      concurrent race: exactly one writer wins ("并发抢同名只一个胜").
 *
 * DB *state* is read as the postgres superuser via psql (the established pattern
 * in migration-0001b.test.ts) because Supabase's service_role has no PostgREST
 * grant on profiles. The host/anon *client* paths are used only to probe the
 * RLS write boundary exactly as a real browser client would hit it.
 */
const LOCAL_UP = localStackRunning();
const i = infra();
const dbReady = LOCAL_UP && i.dbReady;

/** Run SQL as the postgres superuser (bypasses grants/RLS). Throws on SQL error. */
function runSql(sql: string): string {
  const cfg = resolveLocalSupabase({ autoStart: false });
  if (!cfg) throw new Error("local supabase stack not reachable");
  return execFileSync("psql", [cfg.dbUrl, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function scalar(out: string): string {
  return out.trim().split("\n").filter(Boolean).pop() ?? "";
}

describe("task 2.1: host auth — profiles trigger + RLS + username uniqueness", () => {
  beforeAll(() => {
    if (!dbReady) return;
    expect(i.hosts.length).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!dbReady)("first sign-in auto-creates a profiles row (trigger, not client upsert)", async () => {
    const admin = serviceClient();
    const email = "task21-firstlogin@partiful.local";

    // Remove any stale user from a prior run so the trigger fires fresh.
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const stale = list?.users.find((u) => u.email?.toLowerCase() === email);
    if (stale) await admin.auth.admin.deleteUser(stale.id);

    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password: "task21-firstlogin-pw-7c1d9a",
      email_confirm: true,
    });
    expect(error).toBeNull();
    const uid = created?.user?.id ?? "";
    expect(uid).not.toBe("");

    try {
      // No manual insert anywhere — the row must materialize from the trigger.
      expect(scalar(runSql(`select count(*) from public.profiles where id = '${uid}';`))).toBe("1");
    } finally {
      await admin.auth.admin.deleteUser(uid);
    }
  });

  it.skipIf(!dbReady)("a host cannot UPDATE another host's profile (RLS id = auth.uid())", async () => {
    const a = hostClient(i.hosts[0]);
    const victimId = i.hosts[1].id;
    const sentinel = "tampered-by-host-a-2-1";

    // RLS USING (id = auth.uid()) hides host B's row from host A: the update
    // matches zero rows. PostgREST returns success with an empty data set.
    const { data, error } = await a
      .from("profiles")
      .update({ display_name: sentinel })
      .eq("id", victimId)
      .select();
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);

    // And host B's row is provably untouched (read as superuser).
    const victimName = scalar(
      runSql(`select coalesce(display_name, '∅') from public.profiles where id = '${victimId}';`),
    );
    expect(victimName).not.toBe(sentinel);
  });

  it.skipIf(!dbReady)("a host cannot INSERT a profiles row (profiles are trigger-created; client never sends id)", async () => {
    const a = hostClient(i.hosts[0]);
    // Try to forge a profile for an id that is NOT auth.uid() (host B's id).
    // authenticated has no INSERT grant on profiles + RLS WITH CHECK blocks it.
    const { error } = await a
      .from("profiles")
      .insert({ id: i.hosts[1].id, display_name: "forged-by-host-a" });
    expect(error).not.toBeNull();
  });

  it.skipIf(!dbReady)("anon cannot INSERT into profiles", async () => {
    const anon = anonClient();
    const { error } = await anon
      .from("profiles")
      .insert({ id: i.hosts[0].id, display_name: "forged-by-anon" });
    expect(error).not.toBeNull();
  });

  it.skipIf(!dbReady)("concurrent claims of the same username — DB unique index lets exactly one win", async () => {
    const a = hostClient(i.hosts[0]);
    const b = hostClient(i.hosts[1]);
    const uname = "task21_concurrent_winner";

    // Clean slate: clear this username anywhere it lingers + null both hosts'
    // usernames (own-row updates, which RLS allows).
    runSql(`update public.profiles set username = null where username = '${uname}';`);
    await a.from("profiles").update({ username: null }).eq("id", i.hosts[0].id);
    await b.from("profiles").update({ username: null }).eq("id", i.hosts[1].id);

    // Both hosts race to claim the exact same username on their OWN rows.
    const [ra, rb] = await Promise.all([
      a.from("profiles").update({ username: uname }).eq("id", i.hosts[0].id).select(),
      b.from("profiles").update({ username: uname }).eq("id", i.hosts[1].id).select(),
    ]);

    const results = [ra, rb];
    const winners = results.filter((r) => !r.error && (r.data?.length ?? 0) === 1);
    const losers = results.filter((r) => r.error);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The unique index raises 23505 (unique_violation) for the loser.
    expect(losers[0].error?.code).toBe("23505");

    // Exactly one profile ends up holding the username (read as superuser).
    expect(scalar(runSql(`select count(*) from public.profiles where username = '${uname}';`))).toBe("1");

    // Cleanup so re-runs start clean.
    runSql(`update public.profiles set username = null where username = '${uname}';`);
  });
});
