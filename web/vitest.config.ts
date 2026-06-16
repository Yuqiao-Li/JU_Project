import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Mints confirmed host sessions / resets the test DB once for the whole run.
    globalSetup: ["./tests/setup/global-setup.ts"],
    // Loads web/.env.local into each worker so tests see the same env as the app.
    setupFiles: ["./tests/setup/test-env.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    // Integration tests share a single Supabase test DB — run files serially to
    // avoid cross-file races (e.g. capacity/waitlist scenarios in later tasks).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
