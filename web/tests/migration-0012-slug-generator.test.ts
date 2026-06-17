import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.6 — slug generation function + unit tests (SCHEMA "SLUG 生成规格" / D15).
 *
 * The slug is the ONLY public handle on an event and travels in the URL, while
 * the guest_token NEVER does. For private events the readable prefix must not
 * leak anything inferable, and the random tail is the actual anti-enumeration
 * defence — so the tail's randomness is a hard SECURITY property, not cosmetics.
 * The pinned contract this suite hammers:
 *
 *   1. Shape = `{slugify(title, capped at 40)}-{10-char base62 tail}`; an empty
 *      slugify (pure-Chinese / blank / punctuation-only title) collapses to JUST
 *      the random tail — no leading hyphen, no transliteration (D15).
 *   2. The 10-char tail is base62 and comes from `gen_random_bytes()` ONLY. Never
 *      random()/timestamp/sequence (护栏 2) — those are predictable and would let
 *      an attacker walk private slugs.
 *   3. Tails don't repeat across many generations (≈60 bits of entropy).
 *   4. The whole slug contains only URL-safe `[A-Za-z0-9-]` — no forbidden chars.
 *   5. Uniqueness is fail-closed (D15): on a collision the generator retries ONCE
 *      with a FRESH tail, and a second collision RAISES — it never silently falls
 *      back to a weaker source or a longer/degraded slug.
 *
 * Driven through psql as the postgres superuser (functions are unit-tested
 * directly; no PostgREST role path is involved). The collision cases force
 * determinism inside a rolled-back transaction by temporarily overriding the
 * tail generator — the override and seeded rows never persist. Gated on a
 * reachable local stack so the file still skips (green) without Docker.
 */
const LOCAL_UP = localStackRunning();

/** Run SQL as the postgres superuser. Throws (non-zero exit) on any SQL error. */
function runSql(sql: string): string {
  const cfg = resolveLocalSupabase({ autoStart: false });
  if (!cfg) throw new Error("local supabase stack not reachable");
  return execFileSync("psql", [cfg.dbUrl, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** True when `sql` raises a SQL error (used to assert fail-closed behaviour). */
function sqlRaises(sql: string): boolean {
  try {
    runSql(sql);
    return false;
  } catch {
    return true;
  }
}

/** Last non-empty line of psql `-At` output (a single scalar). */
function scalar(out: string): string {
  return out.trim().split("\n").filter(Boolean).pop() ?? "";
}

/** All non-empty lines of psql `-At` output (one per row). */
function rows(out: string): string[] {
  return out.trim().split("\n").filter(Boolean);
}

const TAIL_RE = /^[0-9A-Za-z]{10}$/; // base62, exactly 10 chars
const URLSAFE_RE = /^[A-Za-z0-9-]+$/; // whole slug: URL-safe, no forbidden chars

describe("task 1.6: slug generation (SCHEMA SLUG spec / D15)", () => {
  const i = infra();

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
  });

  // ── The random tail ────────────────────────────────────────────────────────
  describe("slug_random_suffix — the crypto-random tail", () => {
    it.skipIf(!LOCAL_UP)("is exactly 10 chars (explicit and default arg)", () => {
      expect(scalar(runSql(`select length(public.slug_random_suffix(10));`))).toBe("10");
      expect(scalar(runSql(`select length(public.slug_random_suffix());`))).toBe("10");
    });

    it.skipIf(!LOCAL_UP)("is base62 only — no forbidden characters", () => {
      // 300 draws: every one must be exactly 10 base62 chars, never a hyphen,
      // slash, '+', '=', or any other non-base62 byte.
      const out = rows(runSql(`select public.slug_random_suffix(10) from generate_series(1, 300);`));
      expect(out).toHaveLength(300);
      for (const tail of out) expect(tail).toMatch(TAIL_RE);
    });

    it.skipIf(!LOCAL_UP)("does not repeat across many draws (≈60 bits of entropy)", () => {
      // distinct count must equal the draw count — any collision over 500 draws
      // in a 62^10 space signals a degenerate (non-crypto) source.
      const n = scalar(
        runSql(
          `select count(distinct s) from
             (select public.slug_random_suffix(10) as s from generate_series(1, 500)) t;`,
        ),
      );
      expect(n).toBe("500");
    });

    it.skipIf(!LOCAL_UP)("is sourced from gen_random_bytes, never random()/now()/nextval", () => {
      const src = runSql(
        `select pg_get_functiondef('public.slug_random_suffix(integer)'::regprocedure);`,
      );
      expect(src).toContain("gen_random_bytes");
      // No predictable sources anywhere in the tail generator.
      expect(/[^_a-z]random\s*\(/.test(src)).toBe(false);
      expect(/now\s*\(|current_timestamp|nextval\s*\(|timeofday\s*\(/i.test(src)).toBe(false);
    });
  });

  // ── The readable prefix ──────────────────────────────────────────────────────
  describe("slugify — the human-readable prefix", () => {
    it.skipIf(!LOCAL_UP)("lowercases, hyphenates, and strips apostrophes", () => {
      expect(scalar(runSql(`select public.slugify('Rain''s Birthday');`))).toBe("rains-birthday");
      expect(scalar(runSql(`select public.slugify('  Hello,  World!!  ');`))).toBe("hello-world");
    });

    it.skipIf(!LOCAL_UP)("returns empty for pure-Chinese, blank, and punctuation-only titles", () => {
      expect(scalar(runSql(`select public.slugify('生日快乐');`))).toBe("");
      expect(scalar(runSql(`select coalesce(public.slugify(''), '<null>');`))).toBe("");
      expect(scalar(runSql(`select public.slugify('!!! @@@ ###');`))).toBe("");
    });

    it.skipIf(!LOCAL_UP)("caps the prefix at 40 chars with no trailing hyphen", () => {
      // 50 'a's -> capped to 40.
      const capped = scalar(runSql(`select public.slugify(repeat('a', 50));`));
      expect(capped.length).toBeLessThanOrEqual(40);
      expect(capped).toBe("a".repeat(40));
      // A cut that lands on a separator must not leave a dangling hyphen: 39 'a's
      // then a word boundary -> the 40th char would be '-', which is trimmed.
      const word = scalar(runSql(`select public.slugify(${"'" + "a".repeat(39) + " bcd'"});`));
      expect(word.length).toBeLessThanOrEqual(40);
      expect(word.endsWith("-")).toBe(false);
      expect(word).toBe("a".repeat(39));
    });
  });

  // ── The full generator ───────────────────────────────────────────────────────
  describe("generate_event_slug — prefix + tail, unique, fail-closed", () => {
    it.skipIf(!LOCAL_UP)("produces `{slugify}-{10 base62}` for a normal title", () => {
      const slug = scalar(runSql(`select public.generate_event_slug('Rain''s Birthday');`));
      expect(slug).toMatch(/^rains-birthday-[0-9A-Za-z]{10}$/);
      expect(slug).toMatch(URLSAFE_RE);
    });

    it.skipIf(!LOCAL_UP)("collapses to a PURE random tail for Chinese/blank titles", () => {
      // No readable prefix => no leading hyphen, just the 10-char base62 tail (D15:
      // a private event's readable prefix must not leak inferable info).
      const zh = scalar(runSql(`select public.generate_event_slug('生日快乐');`));
      expect(zh).toMatch(TAIL_RE);
      expect(zh.includes("-")).toBe(false);

      const blank = scalar(runSql(`select public.generate_event_slug('   ');`));
      expect(blank).toMatch(TAIL_RE);
      expect(blank.includes("-")).toBe(false);
    });

    it.skipIf(!LOCAL_UP)("caps the readable prefix at 40 chars", () => {
      const slug = scalar(runSql(`select public.generate_event_slug(repeat('b', 80));`));
      const [prefix, tail] = [slug.slice(0, slug.length - 11), slug.slice(slug.length - 10)];
      expect(slug.charAt(slug.length - 11)).toBe("-");
      expect(prefix.length).toBeLessThanOrEqual(40);
      expect(tail).toMatch(TAIL_RE);
    });

    it.skipIf(!LOCAL_UP)("does not produce duplicates across many generations", () => {
      const n = scalar(
        runSql(
          `select count(distinct s) from
             (select public.generate_event_slug('party') as s from generate_series(1, 400)) t;`,
        ),
      );
      expect(n).toBe("400");
    });

    it.skipIf(!LOCAL_UP)("only ever emits URL-safe characters", () => {
      const out = rows(
        runSql(`select public.generate_event_slug('Weekend Trip!') from generate_series(1, 100);`),
      );
      expect(out).toHaveLength(100);
      for (const slug of out) expect(slug).toMatch(URLSAFE_RE);
    });

    it.skipIf(!LOCAL_UP)("retries ONCE with a fresh tail on the first collision", () => {
      const host = i.hosts[0];
      expect(host?.id, "need a confirmed host for the events FK").toBeTruthy();
      // Force determinism: the first tail collides with a seeded slug, the second
      // is free. The generator must retry and return the SECOND candidate. All
      // inside a rolled-back txn so neither the override nor the seed persists.
      // The result is tagged with a RESULT= sentinel and matched out of the
      // output: psql prints command tags (BEGIN/INSERT/ROLLBACK …) to stdout, so
      // the last line is "ROLLBACK", not the slug.
      const out = runSql(
        `begin;
         create sequence public.t16_retry_seq;
         create or replace function public.slug_random_suffix(n integer default 10)
           returns text language sql volatile as $f$
             select case nextval('public.t16_retry_seq')
                      when 1 then 'aaaaaaaaa1' else 'bbbbbbbbb2' end $f$;
         insert into public.profiles (id, display_name)
           values ('${host.id}', 't16') on conflict (id) do nothing;
         insert into public.events (host_id, slug, title)
           values ('${host.id}', 'retrycase-aaaaaaaaa1', 't16 retry');
         select 'RESULT=' || public.generate_event_slug('retrycase');
         rollback;`,
      );
      expect(out.match(/RESULT=(\S+)/)?.[1]).toBe("retrycase-bbbbbbbbb2");
    });

    it.skipIf(!LOCAL_UP)("RAISES (fail-closed) when the retry ALSO collides", () => {
      const host = i.hosts[0];
      expect(host?.id, "need a confirmed host for the events FK").toBeTruthy();
      // Override the tail to a CONSTANT so both attempts produce the same slug,
      // which already exists -> second collision must raise, never degrade.
      const raised = sqlRaises(
        `begin;
         create or replace function public.slug_random_suffix(n integer default 10)
           returns text language sql volatile as $f$ select 'zzzzzzzzzz'::text $f$;
         insert into public.profiles (id, display_name)
           values ('${host.id}', 't16') on conflict (id) do nothing;
         insert into public.events (host_id, slug, title)
           values ('${host.id}', 'collide-zzzzzzzzzz', 't16 collide');
         select public.generate_event_slug('collide');
         rollback;`,
      );
      expect(raised).toBe(true);
    });

    it.skipIf(!LOCAL_UP)("is sourced from gen_random_bytes, never random()/now()/nextval", () => {
      const src = runSql(
        `select pg_get_functiondef('public.generate_event_slug(text)'::regprocedure);`,
      );
      expect(/[^_a-z]random\s*\(/.test(src)).toBe(false);
      expect(/now\s*\(|current_timestamp|nextval\s*\(|timeofday\s*\(/i.test(src)).toBe(false);
    });
  });
});
