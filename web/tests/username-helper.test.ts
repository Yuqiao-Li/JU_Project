import { describe, expect, it } from "vitest";

import {
  RESERVED_USERNAMES,
  USERNAME_MAX,
  USERNAME_MIN,
  normalizeUsername,
  validateUsername,
} from "../lib/profile/username";

/**
 * Task 2.1 — username validation helper (pure, no DB).
 *
 * The DB unique index is the authority on uniqueness (SCHEMA §1 / TASKS 2.1:
 * "username 唯一靠 DB 索引,设置 UI 查仅提示"). This helper is only the client/
 * server-side *shape* check + advisory normalization, shared by the settings
 * form and the advisory availability route. These assertions pin its contract.
 */
describe("task 2.1: username helper", () => {
  it("normalizes by trimming and lowercasing", () => {
    expect(normalizeUsername("  RainParty  ")).toBe("rainparty");
    expect(normalizeUsername("HELLO_World-1")).toBe("hello_world-1");
  });

  it("accepts valid usernames and returns the normalized value", () => {
    for (const input of ["rain", "ada-lovelace", "user_99", "JuCrew", "a1b"]) {
      const r = validateUsername(input);
      expect(r.ok, `${input} should be valid`).toBe(true);
      if (r.ok) expect(r.value).toBe(normalizeUsername(input));
    }
  });

  it("rejects usernames shorter than the minimum", () => {
    const r = validateUsername("ab");
    expect(r.ok).toBe(false);
    expect(USERNAME_MIN).toBeGreaterThanOrEqual(3);
  });

  it("rejects usernames longer than the maximum", () => {
    const r = validateUsername("x".repeat(USERNAME_MAX + 1));
    expect(r.ok).toBe(false);
  });

  it("rejects disallowed characters and bad edges", () => {
    for (const bad of ["has space", "with@symbol", "emoji🎉", "-leading", "trailing-", "dot.dot", "slash/slash"]) {
      expect(validateUsername(bad).ok, `${bad} should be invalid`).toBe(false);
    }
  });

  it("rejects reserved usernames (route/system collisions)", () => {
    expect(RESERVED_USERNAMES.has("dashboard")).toBe(true);
    for (const reserved of ["admin", "dashboard", "login", "settings", "api"]) {
      expect(validateUsername(reserved).ok, `${reserved} should be reserved`).toBe(false);
    }
  });

  it("returns a human-readable error message on failure", () => {
    const r = validateUsername("a b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(typeof r.error).toBe("string");
      expect(r.error.length).toBeGreaterThan(0);
    }
  });
});
