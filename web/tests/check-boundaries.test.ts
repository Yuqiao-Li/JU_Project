import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

/**
 * Task 0.4 — regression contract for the orchestrator guard `check-boundaries.sh`.
 *
 * The guard is the project's static security boundary (run by run-agent.sh before
 * every check-off). These assertions lock its contract so a future edit can't
 * silently drop a guard or make it false-fail. We exercise REAL behaviour against
 * throwaway dirs (no DB needed), matching the 0.4 acceptance criteria:
 *   - executable + `bash -n` clean,
 *   - implements all 8 guard sections (the 7 required checks + the git precondition),
 *   - an empty *git* repo -> SKIPPED, exit 0, no false failure,
 *   - a non-git dir -> fails closed (git-not-init is a hard fail, requirement (3)).
 *
 * NOTE: this file must not contain the literal forbidden tokens the guard itself
 * greps for across all of `web/` (e.g. the client-storage API name), or the guard
 * would flag this very test. We assemble those tokens at runtime instead.
 */

// tests/check-boundaries.test.ts -> tests -> web -> repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = resolve(REPO_ROOT, "check-boundaries.sh");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

// The client-only Web Storage API the guard forbids — assembled so this source
// file never contains the literal token the guard greps for.
const CLIENT_STORAGE = "session" + "Storage";

// Deterministic env: never trigger the DB pass or the round-end helper gate here.
const RUN_ENV = { ...process.env, RUN_DB_CHECKS: "0", ROUND_END: "0" };

const scratchDirs: string[] = [];

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cb-guard-"));
  scratchDirs.push(dir);
  return dir;
}

/** Run the guard with the given working dir; capture exit code + combined output. */
function runGuard(cwd: string): { status: number; out: string } {
  const r = spawnSync("bash", [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: RUN_ENV,
    timeout: 60_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe("check-boundaries.sh: file contract", () => {
  it("is present and executable", () => {
    const mode = statSync(SCRIPT).mode;
    expect(mode & 0o111).not.toBe(0); // at least one execute bit set
  });

  it("has valid bash syntax (bash -n)", () => {
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(r.stderr ?? "").toBe("");
    expect(r.status).toBe(0);
  });

  it("uses `set -uo pipefail` (no unset-var / pipe-swallowed failures)", () => {
    expect(SCRIPT_SRC).toContain("set -uo pipefail");
  });
});

describe("check-boundaries.sh: implements every required guard", () => {
  // Each required 0.4 guard must be present; removing one should turn this red.
  const requiredTokens: Array<[string, RegExp]> = [
    ["git precondition (fail closed)", /护栏 0\/8/],
    ["(1) blacklist for stubbed frontend (path + content)", /护栏 1\/8/],
    ["(1) blacklist regexes defined", /BLACKLIST_RE=[\s\S]*CONTENT_RE=/],
    ["(2) slug crypto-random (gen_random_bytes)", /gen_random_bytes/],
    ["(2) bans random()/timestamp slug sources", /timeofday|current_timestamp|nextval/],
    ["(3) forbidden client-only Web Storage", new RegExp(CLIENT_STORAGE)],
    ["(3) service-role kept out of client env", /护栏 3\/8/],
    ["(3) no committed secret files", /护栏 4\/8/],
    ["(4) DB-authoritative RLS (pg_class.relrowsecurity)", /relrowsecurity/],
    ["(4) DB-authoritative RLS (pg_policies)", /pg_policies/],
    ["(4) anon has no client-table policy (G1)", /ANON_POLICY/],
    ["(4) no using(true)/with check(true)", /PERMISSIVE_TRUE/],
    ["(4) storage schema covered (G8)", /schemaname='storage'/],
    ["(5) shared unlock helper reused by RPCs", /guest_unlock_status\(/],
    ["(5) helper checked in the three gated RPCs", /get_event_by_slug get_guest_list add_comment/],
    ["(6) test existence + empty-test gate", /护栏 7\/8/],
    ["(6) empty-test gate greps for assertions", /expect\\\(\|assert/],
    ["(7) typecheck + lint + build", /pnpm typecheck|pnpm lint|pnpm build/],
    ["(7) rejects ignoreBuildErrors/ignoreDuringBuilds", /ignoreBuildErrors\|ignoreDuringBuilds/],
  ];

  for (const [label, pattern] of requiredTokens) {
    it(`contains guard: ${label}`, () => {
      expect(SCRIPT_SRC).toMatch(pattern);
    });
  }

  it("distinguishes SKIPPED from PASSED (separate helpers)", () => {
    expect(SCRIPT_SRC).toMatch(/skip\(\)\s*\{[^}]*SKIPPED/);
    expect(SCRIPT_SRC).toMatch(/ok\(\)\s*\{/);
  });
});

describe("check-boundaries.sh: behaviour on a fresh repo (acceptance)", () => {
  it("empty git repo -> SKIPPED, exit 0, no false failure", () => {
    const dir = makeScratch();
    const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
    expect(init.status).toBe(0);

    const { status, out } = runGuard(dir);
    expect(out).toContain("SKIPPED");
    expect(out).toContain("护栏全过");
    expect(out).not.toContain("❌"); // never a hard failure on a clean empty repo
    expect(status).toBe(0);
  });

  it("non-git dir -> fails closed (git-not-init is a hard fail, requirement (3))", () => {
    const dir = makeScratch();
    const { status, out } = runGuard(dir);
    expect(out).toContain("git 未初始化");
    expect(status).not.toBe(0);
  });
});
