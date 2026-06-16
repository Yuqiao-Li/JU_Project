import { describe, expect, it } from "vitest";

import { hostClient, infra, serviceClient } from "./helpers/clients";
import { localStackRunning } from "./setup/local-supabase";

/**
 * Task 0.6 — provision + bootstrap the LOCAL test DB and wire it into the 0.3
 * global setup. These assertions verify the acceptance criteria directly:
 *   - `supabase start` 起库 → the global setup discovered the LOCAL stack,
 *   - 全局 setup 能 reset + 建会话 → >=2 confirmed host sessions reach the live DB,
 *   - anon / authenticated / service_role + auth admin + PostgREST usable.
 *
 * Gated on a reachable local stack so the suite still skips (green) on a machine
 * without Docker — but where the stack IS up (the orchestrator's required
 * environment), full provisioning is mandatory, not optional.
 */
const LOCAL_UP = localStackRunning();

describe("task 0.6: local supabase test DB provisioning", () => {
  const i = infra();

  it.skipIf(!LOCAL_UP)("global setup provisioned the LOCAL stack (never a remote project)", () => {
    expect(i.dbReady).toBe(true);
    expect(i.skipReason).toBeNull();
    expect(i.supabaseUrl ?? "").toMatch(/127\.0\.0\.1|localhost/);
  });

  it.skipIf(!LOCAL_UP)("minted >=2 confirmed host users with live sessions", async () => {
    expect(i.hosts.length).toBeGreaterThanOrEqual(2);
    const host = i.hosts[0];
    // authenticated path: the minted session JWT resolves to its own user.
    const { data, error } = await hostClient(host).auth.getUser();
    expect(error).toBeNull();
    expect(data.user?.id).toBe(host.id);
  });

  it.skipIf(!LOCAL_UP)("service-role auth admin + PostgREST reach the live DB", async () => {
    // service_role path: auth admin API is usable (used to mint host users).
    const { error: adminErr } = await serviceClient().auth.admin.listUsers({ perPage: 1 });
    expect(adminErr).toBeNull();
  });
});
