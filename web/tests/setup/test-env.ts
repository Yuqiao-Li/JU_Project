import { loadTestEnv } from "./load-env";

// Runs in every Vitest worker before its test files are collected.
loadTestEnv();
