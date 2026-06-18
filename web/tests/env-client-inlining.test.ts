import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Regression guard for a real deploy bug: the PUBLIC Supabase env vars must be read
 * via a LITERAL `process.env.NEXT_PUBLIC_…` reference so Next statically inlines them
 * into the client bundle. A dynamic `process.env[name]` read is NOT inlined → the var
 * is `undefined` in the BROWSER even when set → the browser Supabase client throws
 * "Missing required environment variable". Server/SSR and the Node test suite use the
 * real process.env, so they never catch it — hence this source-level pin.
 */
const ENV_SRC = readFileSync(fileURLToPath(new URL("../lib/supabase/env.ts", import.meta.url)), "utf8");
// Strip comments so the explanatory prose (which intentionally mentions
// `process.env[name]` to document the pitfall) doesn't trip the code checks.
const ENV_CODE = ENV_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("Supabase env getters inline NEXT_PUBLIC_ vars into the client bundle", () => {
  it("reads the public URL + anon key via a LITERAL process.env.NEXT_PUBLIC_ reference", () => {
    expect(ENV_CODE).toContain("process.env.NEXT_PUBLIC_SUPABASE_URL");
    expect(ENV_CODE).toContain("process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });

  it("does NOT read env via a dynamic process.env[...] access (Next won't inline that)", () => {
    expect(/process\.env\[/.test(ENV_CODE), "no dynamic process.env[name] read in env.ts code").toBe(false);
  });
});
