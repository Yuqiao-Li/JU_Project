import { describe, expect, it } from "vitest";

import { anonClient, infra, hostClient, serviceClient } from "./helpers/clients";

/**
 * Task 0.3 smoke test — proves the Vitest runner + the global setup are wired:
 *   1. assertions actually run,
 *   2. the global setup hands tests a `TestInfra` (env-derived config + hosts),
 *   3. when a live Supabase test DB is reachable, >=2 confirmed host sessions
 *      were minted and the three client paths (anon / host session / trusted
 *      service) construct and authenticate.
 *
 * DB-dependent assertions `skipIf(!dbReady)` so `pnpm test` stays green before
 * the Supabase project is provisioned (tasks 0.5/0.6) and in CI without a DB —
 * while exercising the full path whenever the DB is up.
 */
describe("smoke: test runner", () => {
  it("runs and evaluates assertions", () => {
    expect(1 + 1).toBe(2);
  });

  it("receives test infra from the global setup", () => {
    const i = infra();
    expect(i).toBeDefined();
    expect(typeof i.dbReady).toBe("boolean");
    // hosts is always an array (empty when the DB is unavailable).
    expect(Array.isArray(i.hosts)).toBe(true);
  });
});

describe("smoke: supabase test DB + sessions (global setup)", () => {
  const i = infra();

  it.skipIf(!i.dbReady)("minted >=2 confirmed host sessions", () => {
    expect(i.hosts.length).toBeGreaterThanOrEqual(2);
    for (const host of i.hosts) {
      expect(host.id).toBeTruthy();
      expect(host.accessToken).toBeTruthy();
      expect(host.email).toContain("@");
    }
  });

  it.skipIf(!i.dbReady)("host session authenticates as its own user", async () => {
    const host = i.hosts[0];
    const { data, error } = await hostClient(host).auth.getUser();
    expect(error).toBeNull();
    expect(data.user?.id).toBe(host.id);
  });

  it.skipIf(!i.dbReady)("anon and service client paths construct", () => {
    // anon path = anon key; host path = session; trusted path = service role.
    expect(anonClient()).toBeDefined();
    expect(serviceClient()).toBeDefined();
  });
});
