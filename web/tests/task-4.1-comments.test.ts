import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";
import {
  COMMENT_MAX_LENGTH,
  commentInputSchema,
  formatCommentTime,
  parseComment,
  parseComments,
  type CommentEntry,
} from "../lib/events/comments";

/**
 * Task 4.1 [SECURITY] — the Activity-Feed comment stream on /{slug} (TEST-SPEC §4.1).
 * Written by the INDEPENDENT test agent (never wrote the implementation) with the stance
 * "assume the feed over-shares an author's identity (guest_id / host_id / user_id /
 * contact), lets a not-yet-RSVP'd guest post, keeps a composer up when RSVPs are off,
 * leaks a private event's comments to anon, pulls the feed over a realtime channel or a
 * direct browser read of the comments table, or smuggles an author-forging field through
 * the posting contract".
 *
 * Task 4.1 adds NO new RPC — it RENDERS get_comments and POSTS through add_comment (both
 * 1.5d / migration 0010) behind visibility-aware polling (D4, NOT Realtime). The DB
 * boundary is already covered by migration-0010-*; THIS suite pins the NEW 4.1 surface —
 * the front-end — in three layers, each asserted where it actually lives:
 *
 *  A. THE PURE BOUNDARY (web/lib/events/comments.ts). parseComments / parseComment /
 *     commentInputSchema / formatCommentTime are the client's matching contract — the last
 *     thing between a (possibly regressed/forged) RPC payload and the rendered feed, and
 *     between a hostile composer submission and the POST body. Pure (no DB, no server-only,
 *     no React), so they're hammered directly: a third-tier key riding along
 *     (contact/guest_id/host_id/user_id/token), a garbled / partial entry, an author-forging
 *     field stuffed into the post input, an over-long / empty body, a non-uuid token. The
 *     contract must DESENSITIZE + FAIL-CLOSED + give the client NO author-choosing surface.
 *
 *  B. THE CLIENT WIRING (static source guard). §4.1 + D4 pin HOW the feed moves: by
 *     POLLING, never Realtime, never a direct table read; the feed READ is OPEN (renders
 *     for a locked viewer) while POSTING is an affordance over the DB gate (locked guest →
 *     "RSVP to comment"; rsvp_enabled=false → guest composer hidden, host-only). vitest
 *     can't render the React client (server-only + @/-alias make the page un-importable —
 *     harness notes), and these are STRUCTURAL invariants about the fetch/gate shape, so
 *     they're asserted on the source text — grepping API TOKENS (`.channel(`, `.subscribe(`,
 *     `.from("comments")`), never the English words, which appear in the files' own prose.
 *
 *  C. THE DATA SOURCE (RPC boundary, real role paths). The page feeds the feed from
 *     get_comments over the TRUSTED role (so a private event resolves server-side only, D3)
 *     and posts through add_comment over the cookie-bound client (host author binding, D6).
 *     §4.1's four bullets are asserted on those exact paths, piped through the ACTUAL
 *     front-end boundary (parseComments / parseComment): read-open for an un-RSVP'd viewer;
 *     a locked / forged / cross-event / declined caller is refused the write; an unlocked
 *     guest's post appears on the next read; rsvp_enabled=false makes the guest write fail
 *     while the host posts. Plus the desensitization + private-feed + G1 invariants the
 *     page leans on.
 *
 * Block C is gated on a reachable local stack so the file skips green without Docker;
 * blocks A and B are pure/static and ALWAYS run. Seeding is done as the postgres superuser
 * (psql) since anon/service hold no direct table grant — same pattern as the 1.5x / 2.4 /
 * 3.1 suites. Fixtures are isolated by the per-file `t41` prefix.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Block A — the pure front-end boundary (always runs, no DB)
// ─────────────────────────────────────────────────────────────────────────────

/** A host-only contact value — if the boundary ever lets it through, this exact string
 *  surfaces in the rendered feed. It must NEVER survive. */
const A_SENTINEL_CONTACT = "t41a-contact-secret@sentinel.invalid";
const A_SENTINEL_TOKEN = "41aaaaaa-0000-4000-8000-0000000000ff";

/** The complete, sorted key set a desensitized comment may EVER expose (SCHEMA get_comments). */
const ALLOWED_KEYS = ["author_display_name", "body", "created_at", "id", "is_host"];

/** A fully-valid comment entry, as get_comments/add_comment return it. */
function validEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "41aaaaaa-0000-4000-8000-000000000001",
    body: "t41a-hello",
    author_display_name: "t41a-alice",
    is_host: false,
    created_at: "2026-01-01T10:00:00Z",
    ...over,
  };
}

describe("task 4.1 [SECURITY] A: the comment boundary desensitizes, fails closed, and gives the client no author surface (TEST-SPEC §4.1)", () => {
  it("strips every off-contract / author-identifying key — a regressed get_comments that SELECT *'d raw rows yields ONLY id/body/author_display_name/is_host/created_at, and the host-only contact never survives", () => {
    // Simulate a regressed RPC that leaked the raw comment row joined to its author: every
    // third-tier / internal field rides along. The front-end boundary is the last defence.
    const hostile = [
      validEntry({
        // Third-tier / internal fields that must be dropped:
        contact: A_SENTINEL_CONTACT,
        guest_id: "41aaaaaa-0000-4000-8000-000000000002",
        host_id: "41aaaaaa-0000-4000-8000-000000000003",
        user_id: "41aaaaaa-0000-4000-8000-000000000004",
        guest_token: A_SENTINEL_TOKEN,
        event_id: "41aaaaaa-0000-4000-8000-000000000005",
        gif_url: "https://evil.example/x.gif",
      }),
    ];

    const out = parseComments(hostile);
    expect(out, "the valid comment survives").toHaveLength(1);
    expect(
      Object.keys(out[0]).sort(),
      "entry exposes ONLY the 5 desensitized keys — author identifiers structurally absent",
    ).toEqual(ALLOWED_KEYS);

    const json = JSON.stringify(out);
    expect(json, "host-only contact must never ride through the boundary").not.toContain(
      A_SENTINEL_CONTACT,
    );
    expect(json, "an author guest_token must never ride through").not.toContain(A_SENTINEL_TOKEN);
    expect(json, "no guest_id key leaks").not.toContain("guest_id");
    expect(json, "no host_id key leaks (is_host is the only authorship signal)").not.toContain(
      "host_id",
    );
    expect(json, "no gif surface leaks (MVP 纯文本)").not.toContain("gif_url");
    // The legitimate, desensitized values are intact.
    expect(out[0].body).toBe("t41a-hello");
    expect(out[0].author_display_name).toBe("t41a-alice");
    expect(out[0].is_host).toBe(false);
  });

  it("a non-array payload (object / null / string / number / undefined) collapses to [] — the feed degrades to 'no comments yet', never throws", () => {
    for (const bad of [null, undefined, {}, "rows", 42, true, { comments: [] }] as const) {
      expect(parseComments(bad), `non-array ${JSON.stringify(bad)} ⇒ []`).toEqual([]);
    }
  });

  it("a single malformed entry fails the WHOLE feed closed — a half-validated row never renders a partial feed", () => {
    // One good row + one missing is_host ⇒ the array parse fails ⇒ [] (fail closed, no
    // partial leak): a regressed/garbled response shows nothing rather than a stray comment.
    expect(
      parseComments([validEntry(), { id: "x", body: "b", author_display_name: "n", created_at: "2026-01-01T10:00:00Z" }]),
      "missing is_host ⇒ whole feed []",
    ).toEqual([]);
    // A non-string body (wrong type) collapses it too — fail closed, not coerced.
    expect(
      parseComments([validEntry({ body: 12345 })]),
      "non-string body ⇒ []",
    ).toEqual([]);
    // A missing id collapses it too.
    expect(parseComments([validEntry({ id: undefined })]), "missing id ⇒ []").toEqual([]);
  });

  it("preserves the RPC's 时间正序 (oldest→newest) ordering — the boundary never re-sorts the feed", () => {
    const out = parseComments([
      validEntry({ id: "c1", body: "first", created_at: "2026-01-01T10:00:00Z" }),
      validEntry({ id: "c2", body: "second", created_at: "2026-01-01T11:00:00Z" }),
      validEntry({ id: "c3", body: "third", created_at: "2026-01-01T12:00:00Z" }),
    ]);
    expect(out.map((c) => c.body), "input order preserved").toEqual(["first", "second", "third"]);
  });

  it("parseComment (the add_comment confirmation) strips third-tier keys and returns null on a garbled / non-object payload", () => {
    const ok = parseComment(
      validEntry({ is_host: true, contact: A_SENTINEL_CONTACT, guest_id: "g", host_id: "h" }),
    );
    expect(ok, "a valid confirmation parses").not.toBeNull();
    expect(Object.keys(ok as CommentEntry).sort(), "only the 5 safe keys survive").toEqual(
      ALLOWED_KEYS,
    );
    expect(JSON.stringify(ok), "the confirmation never carries a contact").not.toContain(
      A_SENTINEL_CONTACT,
    );
    // Garbled / wrong-shape confirmations fail closed to null.
    expect(parseComment({ body: "no id" }), "missing id ⇒ null").toBeNull();
    for (const bad of [null, undefined, "x", 7, []] as const) {
      expect(parseComment(bad), `non-object ${JSON.stringify(bad)} ⇒ null`).toBeNull();
    }
  });

  it("the posting contract gives the client NO author-choosing surface — a forged guest_id/host_id/is_host is stripped; only { body, token } reaches the wire (D6 作者服务端绑定)", () => {
    // The UI POSTs commentInputSchema.parse({ body, token }). The author is bound by the DB
    // from the verified token / auth.uid(); there is no author parameter. zod's default strip
    // means even a maliciously-stuffed payload can carry nothing the server would trust.
    const parsed = commentInputSchema.safeParse({
      body: "t41a-trying-to-forge",
      token: A_SENTINEL_TOKEN,
      guest_id: "41aaaaaa-0000-4000-8000-000000000099",
      host_id: "41aaaaaa-0000-4000-8000-000000000098",
      is_host: true,
      gif_url: "https://evil.example/x.gif",
    });
    expect(parsed.success, "the post still parses (extra keys are stripped, not fatal)").toBe(true);
    if (parsed.success) {
      expect(
        Object.keys(parsed.data).sort(),
        "ONLY body + token reach the wire — no author / gif field survives",
      ).toEqual(["body", "token"]);
    }
  });

  it("the posting contract trims the body, rejects an empty / whitespace-only body, bounds the length, and demands a uuid token (a non-uuid token can't be smuggled)", () => {
    // Trimming.
    const trimmed = commentInputSchema.safeParse({ body: "  hi there  ", token: null });
    expect(trimmed.success && trimmed.data.body, "body is trimmed").toBe("hi there");

    // Empty / whitespace-only ⇒ rejected (nothing to post).
    expect(commentInputSchema.safeParse({ body: "" }).success, "empty body rejected").toBe(false);
    expect(
      commentInputSchema.safeParse({ body: "   \n\t " }).success,
      "whitespace-only body rejected",
    ).toBe(false);

    // Over the max ⇒ rejected (UI fail-fast; the RPC is still the real boundary).
    expect(
      commentInputSchema.safeParse({ body: "x".repeat(COMMENT_MAX_LENGTH + 1) }).success,
      "over-long body rejected",
    ).toBe(false);
    expect(
      commentInputSchema.safeParse({ body: "x".repeat(COMMENT_MAX_LENGTH) }).success,
      "a body at exactly the max is accepted",
    ).toBe(true);

    // A non-uuid token can't ride the contract (the token is the event-scoped credential).
    expect(
      commentInputSchema.safeParse({ body: "hi", token: "not-a-uuid" }).success,
      "non-uuid token rejected",
    ).toBe(false);
    // A logged-in host posts with no token (auth binds the author) — null/absent is allowed.
    expect(commentInputSchema.safeParse({ body: "hi", token: null }).success, "null token ok").toBe(
      true,
    );
    expect(commentInputSchema.safeParse({ body: "hi" }).success, "absent token ok").toBe(true);
  });

  it("formatCommentTime renders a non-empty label for a valid ISO and an EMPTY string for a bad value (never throws / never 'Invalid Date')", () => {
    expect(formatCommentTime("2026-06-17T15:42:00Z").length, "valid ISO ⇒ a label").toBeGreaterThan(0);
    for (const bad of ["", "not-a-date", "2026-13-99", "🛑"]) {
      expect(formatCommentTime(bad), `bad value ${JSON.stringify(bad)} ⇒ ""`).toBe("");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block B — the client wiring: read-open polling, NOT Realtime, gated composer
// ─────────────────────────────────────────────────────────────────────────────

/** Read an implementation source file by repo-relative path (relative to this test). */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

// API tokens (NOT the English words, which appear in the files' own comments).
const REALTIME_CHANNEL = /\.channel\s*\(/;
const REALTIME_SUBSCRIBE = /\.subscribe\s*\(/;
const REALTIME_REMOVE = /removeChannel\s*\(/;
const REALTIME_CHANGES = /postgres_changes/;
/** A direct browser read of the comments base table — the thing §4.1 forbids. */
const DIRECT_COMMENTS_READ = /\.from\(\s*['"`]comments['"`]/;

describe("task 4.1 [SECURITY] B: the feed updates by visibility-aware POLLING (read-open), never Realtime, never a direct table read; posting is a gated affordance (TEST-SPEC §4.1)", () => {
  const COMMENTS_FEED = src("components/events/comments-feed.tsx");
  const EVENT_CLIENT = src("app/[slug]/event-client.tsx");
  const READ_COMMENTS = src("lib/events/read-comments.ts");
  const POST_ROUTE = src("app/api/events/[slug]/comments/route.ts");

  it("the comment client path opens NO realtime channel / subscription (D4: 轮询 非 Realtime)", () => {
    for (const [name, source] of [
      ["comments-feed.tsx", COMMENTS_FEED],
      ["event-client.tsx", EVENT_CLIENT],
    ] as const) {
      expect(REALTIME_CHANNEL.test(source), `${name}: no supabase .channel(`).toBe(false);
      expect(REALTIME_SUBSCRIBE.test(source), `${name}: no realtime .subscribe(`).toBe(false);
      expect(REALTIME_REMOVE.test(source), `${name}: no removeChannel(`).toBe(false);
      expect(REALTIME_CHANGES.test(source), `${name}: no postgres_changes subscription`).toBe(false);
    }
  });

  it("the comment client path NEVER reads the comments base table directly from the browser (task 禁止: 不给 anon 开 comments 原表)", () => {
    expect(DIRECT_COMMENTS_READ.test(COMMENTS_FEED), "comments-feed.tsx: no direct comments SELECT").toBe(
      false,
    );
    expect(DIRECT_COMMENTS_READ.test(EVENT_CLIENT), "event-client.tsx: no direct comments SELECT").toBe(
      false,
    );
  });

  it("the feed reaches the client ONLY through the polled endpoint, paused when the tab is hidden (visibility-aware polling)", () => {
    expect(COMMENTS_FEED, "polls our own comments endpoint").toContain("/api/events/");
    expect(COMMENTS_FEED, "re-reads on an interval (polling, not push)").toContain("setInterval");
    expect(
      /visibilityState|visibilitychange/.test(COMMENTS_FEED),
      "visibility-aware polling (don't burn the quota / falsely 429 a hidden tab)",
    ).toBe(true);
  });

  it("the feed READ is OPEN — the poll is NOT token-gated (a locked / un-RSVP'd viewer still sees the feed), unlike the guest-list poll which DOES require a token (D6 读开放)", () => {
    // The comment poll runs regardless of token — read is open. Contrast the guest-list
    // poll in event-client.tsx, which short-circuits on a missing token (the list is
    // second-tier, unlock-gated). Pinning BOTH proves the feed-read isn't accidentally
    // gated like the list.
    expect(
      /if\s*\(\s*!token\s*\)\s*return/.test(COMMENTS_FEED),
      "comments-feed.tsx: the feed poll is NOT short-circuited on a missing token (read-open)",
    ).toBe(false);
    expect(
      /if\s*\(\s*!token\s*\)\s*return/.test(EVENT_CLIENT),
      "event-client.tsx: the guest-LIST poll IS token-gated (unlock-gated), proving the contrast",
    ).toBe(true);
  });

  it("POSTING is gated by exactly the three inputs (host always; guest only when RSVPs are on AND unlocked) — a locked guest gets the RSVP prompt; rsvp_enabled=false hides the guest composer (host-only)", () => {
    // The composer's presence is the affordance; the DB add_comment is the real gate. Pin
    // the affordance logic so a regression can't quietly show a composer to a locked guest.
    expect(
      /canCompose\s*=\s*viewerIsHost\s*\|\|\s*\(\s*rsvpEnabled\s*&&\s*unlocked\s*\)/.test(COMMENTS_FEED),
      "canCompose = viewerIsHost || (rsvpEnabled && unlocked) — host always, guest only when on+unlocked",
    ).toBe(true);
    // Locked guest (RSVPs on, not unlocked): a prompt to RSVP, anchored at the RSVP form.
    expect(COMMENTS_FEED, "locked guest is pointed at #rsvp (未解锁点发提示先RSVP)").toContain("#rsvp");
    // RSVPs off: the guest composer is replaced by a host-only notice, never a textarea.
    expect(
      /Only the host can post/i.test(COMMENTS_FEED),
      "rsvp_enabled=false ⇒ host-only notice (guest 隐藏输入框)",
    ).toBe(true);
  });

  it("the trusted server read reaches the feed ONLY via get_comments over the trusted role (single read path, D3) — never a direct table SELECT, and with NO unlock short-circuit (read-open)", () => {
    expect(READ_COMMENTS, "goes through the trusted role").toContain("createServiceClient");
    expect(READ_COMMENTS, "and through the read-open RPC, not a raw table read").toContain(
      "get_comments",
    );
    expect(
      DIRECT_COMMENTS_READ.test(READ_COMMENTS),
      "read-comments.ts: no direct comments SELECT",
    ).toBe(false);
    expect(
      /if\s*\(\s*!.*token.*\)\s*return/.test(READ_COMMENTS),
      "read-comments.ts: no unlock/token short-circuit — read is open",
    ).toBe(false);
  });

  it("the POST route binds the host author server-side (cookie client) and feeds the DB write-limit the REAL client IP — author / IP are never client-trusted (D6 / D14)", () => {
    expect(POST_ROUTE, "posts through add_comment").toContain("add_comment");
    // Cookie-bound server client ⇒ a logged-in host's auth.uid() reaches the RPC (host author
    // binding); NOT the trusted service role (which would erase the caller's identity).
    expect(POST_ROUTE, "uses the cookie-bound server client for host auth").toContain("createClient");
    expect(
      /createServiceClient/.test(POST_ROUTE),
      "the POST does NOT use the service role (would lose the host's auth.uid())",
    ).toBe(false);
    // Real, un-spoofable client IP into the per-identity DB rate-limit bucket.
    expect(POST_ROUTE, "feeds the real client IP to the write-side limit").toContain("ipFromHeaders");
    expect(POST_ROUTE, "the IP rides client_fingerprint into add_comment").toContain(
      "client_fingerprint",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block C — the data source: get_comments (read-open) + add_comment (write-gated)
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_UP = localStackRunning();
const FN_GET = "get_comments";
const FN_ADD = "add_comment";

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

/** IN-parameter names of a function, in order — to pin the RPC signature the page depends on. */
function inArgNames(fn: string): string[] {
  const namesRaw = scalar(
    runSql(
      `select coalesce(array_to_string(proargnames, ','), '') from pg_proc
         where proname='${fn}' and pronamespace='public'::regnamespace limit 1;`,
    ),
  );
  const modesRaw = scalar(
    runSql(
      `select coalesce(array_to_string(proargmodes::text[], ','), '') from pg_proc
         where proname='${fn}' and pronamespace='public'::regnamespace limit 1;`,
    ),
  );
  const names = namesRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const modes = modesRaw ? modesRaw.split(",").map((s) => s.trim()) : [];
  return names.filter((_, idx) => modes.length === 0 || modes[idx] === "i" || modes[idx] === "b");
}

type ApiResult = { data: unknown; error: { message?: string } | null };

// ── Fixtures (t41 prefix).
const PREFIX = "t41";
const E_OPEN = "t41-open"; // public, rsvp_enabled=true — read-open + unlocked-posts + locked-rejected
const E_RSVPOFF = "t41-rsvpoff"; // public, rsvp_enabled=false — host-only commenting (D6)
const E_PRIVATE = "t41-private"; // private — feed resolves only via the trusted role (D3)
const E_OTHER = "t41-other"; // public, rsvp_enabled=true — for the cross-event token attack

const C_SENTINEL_CONTACT = "t41-contact-secret@sentinel.invalid"; // host-only; must NEVER appear

const SEED_HOST_BODY = "t41-host-welcome"; // host comment on E_OPEN (oldest)
const SEED_GUEST_BODY = "t41-guest-hello"; // guest comment on E_OPEN (newer)
const PRIVATE_BODY = "t41-private-only-comment"; // on E_PRIVATE — must never leak to anon

const T_GOING = "41c00000-0000-4000-8000-000000000001"; // E_OPEN going (+contact) — UNLOCKED
const T_NOTGOING = "41c00000-0000-4000-8000-000000000002"; // E_OPEN not_going — NOT unlocked
const T_OFF_GOING = "41c00000-0000-4000-8000-000000000003"; // E_RSVPOFF going — unlocked yet host-only
const T_PRIV_GOING = "41c00000-0000-4000-8000-000000000004"; // E_PRIVATE going
const T_FORGED = "41c00000-0000-4000-8000-0000000000ff"; // valid uuid, never inserted

describe("task 4.1 [SECURITY] C: the feed's data source — get_comments (read-open) + add_comment (write-gated) over real role paths (TEST-SPEC §4.1)", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];
  /** Host A's effective profile display_name — the author name of a host comment. The
   *  minted host's profile starts nameless, so we set a known one and read it back (the
   *  feed resolves a host author from profiles, exactly as the page renders it). */
  let hostAName = "";

  function anon(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  /** The trusted SSR/poll read path — read-comments.ts uses the service role (D3). */
  function service(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.serviceRoleKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  /** A host session (auth.uid() = host) — the POST route's cookie-bound client binds the host. */
  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  async function callGet(client: SupabaseClient, slug: string, token?: string): Promise<ApiResult> {
    const body: Record<string, unknown> = { slug };
    if (token !== undefined) body.guest_token = token;
    return (await client.rpc(FN_GET, body)) as ApiResult;
  }

  async function callAdd(
    client: SupabaseClient,
    slug: string,
    opts: { token?: string; body: string; fingerprint?: string },
  ): Promise<ApiResult> {
    const body: Record<string, unknown> = { slug, body: opts.body };
    if (opts.token !== undefined) body.guest_token = opts.token;
    if (opts.fingerprint !== undefined) body.client_fingerprint = opts.fingerprint;
    return (await client.rpc(FN_ADD, body)) as ApiResult;
  }

  /** Bodies the page would render from a get_comments payload (through the real boundary). */
  function renderedBodies(payload: unknown): string[] {
    return parseComments(payload).map((c) => c.body);
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();

    // Pinned signatures — the page's reads/writes depend on these exact arg names/order.
    expect(inArgNames(FN_GET), "get_comments signature is pinned").toEqual(["slug", "guest_token"]);
    expect(inArgNames(FN_ADD), "add_comment signature is pinned").toEqual([
      "slug",
      "guest_token",
      "body",
      "client_fingerprint",
    ]);

    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't41 host A')
         on conflict (id) do update set display_name = excluded.display_name;`,
    );
    hostAName = scalar(runSql(`select display_name from public.profiles where id='${hostA.id}';`));

    runSql(
      `insert into public.events
         (host_id, slug, title, visibility, status, rsvp_enabled) values
         ('${hostA.id}','${E_OPEN}',    't41 open',    'public', 'published', true),
         ('${hostA.id}','${E_RSVPOFF}', 't41 rsvpoff', 'public', 'published', false),
         ('${hostA.id}','${E_PRIVATE}', 't41 private', 'private','published', true),
         ('${hostA.id}','${E_OTHER}',   't41 other',   'public', 'published', true);`,
    );

    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact) values
         ((select id from public.events where slug='${E_OPEN}'),    '${T_GOING}'::uuid,     't41-alice-going',  '${C_SENTINEL_CONTACT}'),
         ((select id from public.events where slug='${E_OPEN}'),    '${T_NOTGOING}'::uuid,  't41-carol-cantgo', null),
         ((select id from public.events where slug='${E_RSVPOFF}'), '${T_OFF_GOING}'::uuid, 't41-dave-going',   null),
         ((select id from public.events where slug='${E_PRIVATE}'), '${T_PRIV_GOING}'::uuid,'t41-erin-going',   null);`,
    );

    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_GOING}'::uuid     then 'going'
             when '${T_NOTGOING}'::uuid  then 'not_going'
             when '${T_OFF_GOING}'::uuid then 'going'
             when '${T_PRIV_GOING}'::uuid then 'going'
           end, 0
         from public.guests g
         where g.guest_token in (
           '${T_GOING}'::uuid,'${T_NOTGOING}'::uuid,'${T_OFF_GOING}'::uuid,'${T_PRIV_GOING}'::uuid
         );`,
    );

    // Seed the feed: a host comment then a guest comment on E_OPEN (oldest→newest), and a
    // comment on the PRIVATE event that must only ever resolve via the trusted role.
    runSql(
      `insert into public.comments (event_id, host_id, guest_id, body, created_at) values
         ((select id from public.events where slug='${E_OPEN}'), '${hostA.id}', null,
            '${SEED_HOST_BODY}', '2026-01-01T10:00:00Z'),
         ((select id from public.events where slug='${E_OPEN}'), null,
            (select id from public.guests where guest_token='${T_GOING}'::uuid),
            '${SEED_GUEST_BODY}', '2026-01-01T11:00:00Z'),
         ((select id from public.events where slug='${E_PRIVATE}'), '${hostA.id}', null,
            '${PRIVATE_BODY}', '2026-01-01T10:00:00Z');`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  // ── §4.1 bullet 1 — an un-RSVP'd viewer CAN read the feed (read-open), desensitized ──
  it.skipIf(!LOCAL_UP)(
    "an un-RSVP'd viewer reads the feed (read-open) — anon with NO token gets the comments through get_comments, oldest→newest, with only id/body/author_display_name/is_host/created_at and NEVER a contact / token / author id",
    async () => {
      const r = await callGet(anon(), E_OPEN);
      expect(r.error, JSON.stringify(r.error)).toBeNull();
      expect(Array.isArray(r.data), "feed is a jsonb array").toBe(true);

      // Raw-RPC structural checks: third-tier absent at the source.
      const rawJson = JSON.stringify(r.data);
      expect(rawJson, "host-only contact must never be in the feed payload").not.toContain(
        C_SENTINEL_CONTACT,
      );
      for (const tok of [T_GOING, T_NOTGOING, T_OFF_GOING, T_PRIV_GOING]) {
        expect(rawJson, `author guest_token ${tok} must never appear`).not.toContain(tok);
      }

      // Pipe through the ACTUAL front-end boundary the page uses, then assert.
      const entries = parseComments(r.data);
      expect(entries.map((c) => c.body), "read-open feed, oldest→newest").toEqual([
        SEED_HOST_BODY,
        SEED_GUEST_BODY,
      ]);
      const host = entries[0];
      const guest = entries[1];
      expect(host.is_host, "the host comment is badged is_host=true").toBe(true);
      expect(host.author_display_name, "host author = host's profile display_name").toBe(hostAName);
      expect(guest.is_host, "the guest comment is is_host=false").toBe(false);
      expect(guest.author_display_name, "guest author = guest display_name").toBe("t41-alice-going");
      for (const c of entries) {
        expect(Object.keys(c).sort(), "rendered entry exposes only the 5 safe keys").toEqual(
          ALLOWED_KEYS,
        );
      }
    },
  );

  it.skipIf(!LOCAL_UP)(
    "read is open regardless of the token — passing NO token, a FORGED token, or a not_going decliner's token all return the SAME feed (guest_token is unused on the read path)",
    async () => {
      const an = anon();
      const base = renderedBodies((await callGet(an, E_OPEN)).data);
      const forged = renderedBodies((await callGet(an, E_OPEN, T_FORGED)).data);
      const decliner = renderedBodies((await callGet(an, E_OPEN, T_NOTGOING)).data);
      expect(base.length, "feed is non-empty").toBeGreaterThan(0);
      expect(forged, "a forged token doesn't change the read-open feed").toEqual(base);
      expect(decliner, "a decliner can still READ the feed (read-open)").toEqual(base);
    },
  );

  // ── §4.1 bullet 2 — an un-RSVP'd / forged / declined caller CANNOT post ──
  it.skipIf(!LOCAL_UP)(
    "an un-RSVP'd guest CANNOT post — no token / a forged token / a not_going decliner's token are each rejected, with a reason the route maps to the 'RSVP first' affordance (未解锁不得发)",
    async () => {
      for (const [label, token] of [
        ["no-token", undefined],
        ["forged-token", T_FORGED],
        ["decliner-token", T_NOTGOING],
      ] as const) {
        const r = await callAdd(anon(), E_OPEN, { token, body: `t41-locked-${label}` });
        expect(r.error, `${label}: a locked write must be REJECTED`).not.toBeNull();
        expect(
          (r.error?.message ?? "").toLowerCase(),
          `${label}: the DB reason mentions RSVP so the route returns the 'RSVP first' affordance`,
        ).toContain("rsvp");
      }

      // And the rejected attempts wrote nothing — the feed is unchanged (no partial leak).
      const after = renderedBodies((await callGet(anon(), E_OPEN)).data);
      for (const label of ["no-token", "forged-token", "decliner-token"]) {
        expect(after.join("\n"), `${label}: nothing was inserted`).not.toContain(`t41-locked-${label}`);
      }
    },
  );

  // ── §4.1 bullet 3 — an unlocked (going) guest posts and it appears on the next read ──
  it.skipIf(!LOCAL_UP)(
    "an UNLOCKED (going) guest posts successfully and the comment appears on the next read — desensitized (is_host=false, no author id / contact), newest at the end",
    async () => {
      const body = "t41-going-guest-posts-now";
      const add = await callAdd(anon(), E_OPEN, { token: T_GOING, body });
      expect(add.error, `unlocked post should succeed: ${JSON.stringify(add.error)}`).toBeNull();

      // The confirmation is desensitized — pipe it through the real boundary.
      const confirmed = parseComment(add.data);
      expect(confirmed, "a desensitized confirmation comes back").not.toBeNull();
      expect(confirmed?.body, "confirmation echoes the body").toBe(body);
      expect(confirmed?.is_host, "a guest post is is_host=false").toBe(false);
      expect(Object.keys(confirmed as CommentEntry).sort(), "confirmation has only safe keys").toEqual(
        ALLOWED_KEYS,
      );
      expect(JSON.stringify(add.data), "confirmation never carries the author's token").not.toContain(
        T_GOING,
      );

      // Next poll (read-open) surfaces it as the newest comment.
      const after = renderedBodies((await callGet(anon(), E_OPEN)).data);
      expect(after, "the new comment appears on the next read").toContain(body);
      expect(after[after.length - 1], "newest comment is last (时间正序)").toBe(body);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "a CROSS-EVENT token cannot post — E_OPEN's going token used against E_OTHER is rejected (the unlock helper scopes the token to its event; wrong-event = not unlocked)",
    async () => {
      const r = await callAdd(anon(), E_OTHER, { token: T_GOING, body: "t41-cross-event-attack" });
      expect(r.error, "a token from another event must NOT unlock posting here").not.toBeNull();
      const after = renderedBodies((await callGet(anon(), E_OTHER)).data);
      expect(after.join("\n"), "nothing was inserted on the other event").not.toContain(
        "t41-cross-event-attack",
      );
    },
  );

  // ── §4.1 bullet 4 — rsvp_enabled=false ⇒ host-only: guest refused, host posts ──
  it.skipIf(!LOCAL_UP)(
    "rsvp_enabled=false ⇒ host-only: a GOING (otherwise unlocked) guest is STILL refused, the host CAN post, and the feed stays readable to everyone (评论降级 host-only)",
    async () => {
      // The guest is going — unlocked elsewhere — yet rsvp_enabled=false makes commenting
      // host-only, so the guest write is refused outright.
      const guest = await callAdd(anon(), E_RSVPOFF, {
        token: T_OFF_GOING,
        body: "t41-rsvpoff-guest-should-fail",
      });
      expect(guest.error, "rsvp_enabled=false ⇒ even an unlocked guest is host-only-rejected").not.toBeNull();

      // The host (auth.uid() = host_id) may always post.
      const hostBody = "t41-rsvpoff-host-posts";
      const host = await callAdd(asHost(hostA.accessToken), E_RSVPOFF, { body: hostBody });
      expect(host.error, `the host may post on an rsvp_enabled=false event: ${JSON.stringify(host.error)}`).toBeNull();
      const confirmed = parseComment(host.data);
      expect(confirmed?.is_host, "the host's comment is badged is_host=true").toBe(true);

      // Read stays open: anon (no token) still sees the host's post, never the guest's.
      const after = renderedBodies((await callGet(anon(), E_RSVPOFF)).data);
      expect(after, "the host's post is readable").toContain(hostBody);
      expect(after.join("\n"), "the refused guest write never landed").not.toContain(
        "t41-rsvpoff-guest-should-fail",
      );
    },
  );

  it.skipIf(!LOCAL_UP)(
    "host-only is scoped to THIS event's host — a different logged-in user (a stranger host) is treated as a guest and refused when not unlocked (host may always post is NOT 'any logged-in user')",
    async () => {
      if (!hostB?.accessToken) return; // need a 2nd host session
      const r = await callAdd(asHost(hostB.accessToken), E_OPEN, {
        body: "t41-stranger-host-should-fail",
      });
      expect(r.error, "a non-owner logged-in user is not the host — refused without an unlock").not.toBeNull();
      const after = renderedBodies((await callGet(anon(), E_OPEN)).data);
      expect(after.join("\n"), "the stranger's write never landed").not.toContain(
        "t41-stranger-host-should-fail",
      );
    },
  );

  // ── §4.1 / D3 — a PRIVATE event's feed resolves ONLY through the trusted role ──
  it.skipIf(!LOCAL_UP)(
    "a PRIVATE event's feed is reachable ONLY via the trusted role (the page's SSR path) — anon gets [] (private comments never leak), service_role gets the comment",
    async () => {
      // anon hitting the private slug directly (bypassing SSR) gets nothing (D3 visibility gate).
      const viaAnon = await callGet(anon(), E_PRIVATE);
      expect(viaAnon.error, JSON.stringify(viaAnon.error)).toBeNull();
      expect(Array.isArray(viaAnon.data) && (viaAnon.data as unknown[]).length, "anon ⇒ empty private feed").toBe(0);
      expect(JSON.stringify(viaAnon.data ?? []), "the private comment body never leaks to anon").not.toContain(
        PRIVATE_BODY,
      );

      // Even an authenticated guest of the private event (passing the going token) gets []
      // on the direct path — only the trusted SSR role resolves it.
      const viaTokenAnon = await callGet(anon(), E_PRIVATE, T_PRIV_GOING);
      expect(
        Array.isArray(viaTokenAnon.data) && (viaTokenAnon.data as unknown[]).length,
        "a token does not open the private direct path",
      ).toBe(0);

      // The trusted role (read-comments.ts) DOES resolve it — that's the page's only path.
      const viaService = renderedBodies((await callGet(service(), E_PRIVATE)).data);
      expect(viaService, "service_role (SSR) resolves the private feed").toContain(PRIVATE_BODY);
    },
  );

  // ── §4.1 — the feed reaches the page ONLY through the RPC (G1: 不给 anon 开 comments 原表) ──
  it.skipIf(!LOCAL_UP)(
    "anon cannot read the comments table directly from the browser — the feed reaches the page ONLY through get_comments (G1: no direct anon SELECT on comments)",
    async () => {
      const an = anon();
      const evId = scalar(runSql(`select id from public.events where slug='${E_OPEN}';`));
      const direct = await an.from("comments").select("*").eq("event_id", evId);
      expect((direct.data ?? []).length, "anon direct SELECT on comments must leak no rows").toBe(0);
      // And the contact carried on an author's guest row is unreachable by any anon path.
      const guestRows = await an.from("guests").select("contact").eq("event_id", evId);
      expect(JSON.stringify(guestRows.data ?? []), "anon must not read any author contact").not.toContain(
        C_SENTINEL_CONTACT,
      );
    },
  );
});
