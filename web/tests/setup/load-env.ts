import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tests/setup/load-env.ts -> tests/setup -> tests -> web
const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Minimal `KEY=VALUE` dotenv parser (handles `#` comments, quotes, `export`). */
function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

let loaded = false;

/**
 * Load `web/.env.local` (then `web/.env`) into `process.env` for tests, WITHOUT
 * overriding values already present — the orchestrator exports `SUPABASE_DB_URL`
 * in the shell and that must win. Mirrors how Next resolves env so tests see the
 * same `NEXT_PUBLIC_*` / service-role values as the app. Idempotent.
 */
export function loadTestEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const file of [".env.local", ".env"]) {
    const path = resolve(WEB_DIR, file);
    if (!existsSync(path)) continue;
    for (const [key, value] of Object.entries(parseDotenv(readFileSync(path, "utf8")))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export { WEB_DIR };
