import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostClient, infra, serviceClient } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 2.2a — create/edit event form, core fields (integration).
 *
 * The form is frontend, but it leans on DB guarantees the constitution makes
 * non-negotiable. These are the task's 【测试】 assertions plus the security-
 * bearing behaviour (server-side password hashing is host-only), written
 * adversarially:
 *
 *   1. The create flow mints a readable + crypto-tailed slug via
 *      generate_event_slug, and the owning host can read their event back
 *      IMMEDIATELY through the RLS path (D9 — no self-lock). The AFTER INSERT
 *      trigger writes the event_hosts owner row.
 *   2. Slugs are unique (a fresh crypto-random tail per call).
 *   3. RLS host isolation: a different host cannot read the event.
 *   4. The password field is set/cleared through the host-only SECURITY DEFINER
 *      RPC set_event_password — the plaintext is NEVER stored (bcrypt only), and
 *      a non-owner / no-auth caller cannot touch another host's password (D7③).
 *
 * DB state is read as the postgres superuser via psql (the established pattern,
 * see task-2.1-host-auth.test.ts) since service_role has no PostgREST grant on
 * some columns; the host/anon client paths probe exactly what a browser hits.
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

const SLUG_TAIL = /-[0-9A-Za-z]{10}$/;
const createdIds: string[] = [];

/** Create an event as host A and remember it for cleanup. */
async function createAsHostA(title: string, extra: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const a = hostClient(i.hosts[0]);
  const { data: slug, error: slugErr } = await a.rpc("generate_event_slug", { title });
  expect(slugErr).toBeNull();
  const { data: ev, error: insErr } = await a
    .from("events")
    .insert({ host_id: i.hosts[0].id, slug: slug as string, title, ...extra })
    .select("id, slug")
    .single();
  expect(insErr).toBeNull();
  const id = (ev as { id: string }).id;
  createdIds.push(id);
  return { id, slug: slug as string };
}

describe("task 2.2a: create/edit event — slug + host read-back + password set/clear", () => {
  beforeAll(() => {
    if (!dbReady) return;
    expect(i.hosts.length).toBeGreaterThanOrEqual(2);
  });

  afterAll(() => {
    if (!dbReady || createdIds.length === 0) return;
    const list = createdIds.map((id) => `'${id}'`).join(",");
    runSql(`delete from public.events where id in (${list});`);
  });

  it.skipIf(!dbReady)("mints a readable, crypto-tailed slug and the host reads back their own new event (D9)", async () => {
    const a = hostClient(i.hosts[0]);

    const { data: slug, error: slugErr } = await a.rpc("generate_event_slug", { title: "Rain's Birthday" });
    expect(slugErr).toBeNull();
    expect(typeof slug).toBe("string");
    // Human-readable prefix (apostrophe dropped) + 10-char base62 tail.
    expect(slug as string).toMatch(/^rains-birthday-[0-9A-Za-z]{10}$/);

    const { data: inserted, error: insErr } = await a
      .from("events")
      .insert({
        host_id: i.hosts[0].id,
        slug: slug as string,
        title: "Rain's Birthday",
        visibility: "public",
        status: "published",
      })
      .select("id, slug, status")
      .single();
    expect(insErr).toBeNull();
    expect(inserted).not.toBeNull();
    const id = (inserted as { id: string }).id;
    createdIds.push(id);

    // D9: the owning host reads their just-created row back immediately.
    const { data: readback, error: readErr } = await a
      .from("events")
      .select("id, slug, title, status")
      .eq("id", id)
      .maybeSingle();
    expect(readErr).toBeNull();
    expect(readback).not.toBeNull();
    expect((readback as { slug: string }).slug).toBe(slug);
    expect((readback as { status: string }).status).toBe("published");

    // The AFTER INSERT trigger wrote the event_hosts owner row.
    expect(
      scalar(runSql(`select role from public.event_hosts where event_id = '${id}' and user_id = '${i.hosts[0].id}';`)),
    ).toBe("owner");
  });

  it.skipIf(!dbReady)("each slug gets a fresh crypto-random tail (uniqueness)", async () => {
    const a = hostClient(i.hosts[0]);
    const [s1, s2] = await Promise.all([
      a.rpc("generate_event_slug", { title: "Same Title Party" }),
      a.rpc("generate_event_slug", { title: "Same Title Party" }),
    ]);
    expect(s1.data).not.toBe(s2.data);
    expect(s1.data as string).toMatch(SLUG_TAIL);
    expect(s2.data as string).toMatch(SLUG_TAIL);
  });

  it.skipIf(!dbReady)("RLS isolation: another host cannot read the created event", async () => {
    const { id } = await createAsHostA("A Thing Only Mine");
    const b = hostClient(i.hosts[1]);
    const { data: seen, error } = await b.from("events").select("id").eq("id", id);
    expect(error).toBeNull();
    expect(seen ?? []).toHaveLength(0);
  });

  it.skipIf(!dbReady)("set_event_password stores a bcrypt hash (never plaintext); verify accepts/rejects; clear nulls it", async () => {
    const a = hostClient(i.hosts[0]);
    const { id, slug } = await createAsHostA("Locked Loft Party", { visibility: "public", status: "published" });

    const secret = "hunter2-loft";
    const { error: setErr } = await a.rpc("set_event_password", { event_id: id, password: secret });
    expect(setErr).toBeNull();

    // Stored value is a bcrypt hash, never the plaintext.
    const stored = scalar(runSql(`select coalesce(view_password_hash, '∅') from public.events where id = '${id}';`));
    expect(stored).not.toBe("∅");
    expect(stored).not.toBe(secret);
    expect(stored.startsWith("$2")).toBe(true); // bcrypt hashes start with $2…

    // The pinned verifier accepts the right password, rejects the wrong one.
    expect((await a.rpc("verify_event_password", { slug, password: secret })).data).toBe(true);
    expect((await a.rpc("verify_event_password", { slug, password: "wrong-password" })).data).toBe(false);

    // Clearing (empty string) nulls the hash — the gate is open again.
    const { error: clrErr } = await a.rpc("set_event_password", { event_id: id, password: "" });
    expect(clrErr).toBeNull();
    expect(scalar(runSql(`select coalesce(view_password_hash, '∅') from public.events where id = '${id}';`))).toBe("∅");
  });

  it.skipIf(!dbReady)("set_event_password is host-only: a different host and a no-auth caller are rejected (D7③)", async () => {
    const { id } = await createAsHostA("Owner Only Soiree");

    // Host B tries to set host A's event password → raised exception.
    const b = hostClient(i.hosts[1]);
    const { error: bErr } = await b.rpc("set_event_password", { event_id: id, password: "stealmyparty" });
    expect(bErr).not.toBeNull();

    // service_role has no auth.uid() context → the host-only check rejects it.
    const svc = serviceClient();
    const { error: svcErr } = await svc.rpc("set_event_password", { event_id: id, password: "trustmebro" });
    expect(svcErr).not.toBeNull();

    // No unauthorized writer managed to set a hash.
    expect(scalar(runSql(`select coalesce(view_password_hash, '∅') from public.events where id = '${id}';`))).toBe("∅");
  });
});
