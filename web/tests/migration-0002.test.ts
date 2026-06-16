import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.2 — extension tables migration (logical "0002", shipped as the next
 * purely-numeric file 0003_extension_tables.sql; the Supabase CLI only applies
 * <number>_name.sql, so a "0002b_*" file would be silently skipped — same reason
 * 1.1b's "0001b" landed as 0002_core_tables_b.sql).
 *
 * Builds the remaining tables (🟡 = table-only, no UI) + rate_limits (🟢, D14):
 *   comments, comment_reactions, event_photos, date_options, date_votes,
 *   questions (type incl. 'social'), answers, scheduled_reminders, broadcasts,
 *   rate_limits.
 *
 * Acceptance (TASKS 1.2 / SCHEMA §6–15): SQL valid; every table carries its
 * SCHEMA columns; constraints reject violations — notably comments' "exactly one
 * of guest_id/host_id non-null" and rate_limits' unique(bucket_key, window_start).
 *
 * Like 1.1a/1.1b this migration ships DDL + RLS (enabled-on-creation, 绝不削弱
 * RLS) but NO client GRANTs — exposure/host-grants land in 1.3/1.4. So these
 * assertions hit the DB directly as the `postgres` superuser (bypassing
 * grants/RLS), gated on a reachable local stack so the suite still skips green
 * without Docker.
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

/** Last non-empty line of psql `-At` output (the value of a single-column row). */
function scalar(out: string): string {
  return out.trim().split("\n").filter(Boolean).pop() ?? "";
}

function jsonRow(out: string): Record<string, unknown> {
  return JSON.parse(scalar(out) || "{}");
}

/** Insert ... returning row_to_json, via a CTE so `-At` yields just the JSON. */
function insertReturningJson(sql: string): Record<string, unknown> {
  return jsonRow(runSql(`with ins as (${sql} returning *) select row_to_json(ins.*) from ins;`));
}

// Every column from SCHEMA §6–15. Deterministic acceptance against the column list.
const EXPECTED_COLUMNS: Record<string, string[]> = {
  comments: ["id", "event_id", "guest_id", "host_id", "body", "gif_url", "created_at"],
  comment_reactions: ["id", "comment_id", "guest_id", "emoji", "created_at"],
  event_photos: ["id", "event_id", "guest_id", "host_id", "image_url", "created_at"],
  date_options: ["id", "event_id", "starts_at", "ends_at", "created_at"],
  date_votes: ["id", "date_option_id", "guest_id", "created_at"],
  questions: ["id", "event_id", "prompt", "type", "options", "required", "position", "created_at"],
  answers: ["id", "question_id", "guest_id", "value", "created_at"],
  scheduled_reminders: [
    "id", "event_id", "guest_id", "remind_at", "channel", "status", "sent_at", "created_at",
  ],
  broadcasts: ["id", "event_id", "body", "channel", "sent_at", "created_at"],
  rate_limits: ["id", "bucket_key", "window_start", "count"],
};

const ALL_TABLES = Object.keys(EXPECTED_COLUMNS);

describe("task 1.2: extension tables migration (comments/…/rate_limits)", () => {
  const i = infra();
  const hostId = i.hosts[0]?.id ?? "00000000-0000-0000-0000-000000000000";

  let eventId = "";
  let guestId = ""; // used by the unique-constraint duplicate probes
  let guest2Id = ""; // used by the column-presence inserts so probes stay isolated
  let commentId = ""; // a guest-authored comment (FK target for comment_reactions)
  let dateOptionId = "";
  let questionId = "";

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady).toBe(true);
    // host[0]'s profile is auto-created by the auth.users trigger; upsert
    // defensively so this file is self-contained regardless of run order.
    runSql(
      `insert into public.profiles (id, display_name) values ('${hostId}', 'Host A 1.2')
       on conflict (id) do nothing;`,
    );
    eventId = scalar(
      runSql(
        `with ins as (insert into public.events (host_id, title) values ('${hostId}', '1.2 Event') returning id)
         select id from ins;`,
      ),
    );
    guestId = scalar(
      runSql(
        `with ins as (insert into public.guests (event_id, display_name) values ('${eventId}', 'Ada') returning id)
         select id from ins;`,
      ),
    );
    guest2Id = scalar(
      runSql(
        `with ins as (insert into public.guests (event_id, display_name) values ('${eventId}', 'Bob') returning id)
         select id from ins;`,
      ),
    );
    // A guest-authored comment: guest_id set, host_id null (exactly-one-author).
    commentId = scalar(
      runSql(
        `with ins as (insert into public.comments (event_id, guest_id, body) values ('${eventId}', '${guestId}', 'hi') returning id)
         select id from ins;`,
      ),
    );
    dateOptionId = scalar(
      runSql(
        `with ins as (insert into public.date_options (event_id, starts_at) values ('${eventId}', now()) returning id)
         select id from ins;`,
      ),
    );
    questionId = scalar(
      runSql(
        `with ins as (insert into public.questions (event_id, prompt, type) values ('${eventId}', 'Veg?', 'single') returning id)
         select id from ins;`,
      ),
    );
  });

  it.skipIf(!LOCAL_UP)("every table exists and carries every SCHEMA §6–15 column", () => {
    // comments / date_options / questions already have a row from beforeAll.
    const comment = jsonRow(runSql(`select row_to_json(t) from public.comments t where t.id = '${commentId}';`));
    for (const c of EXPECTED_COLUMNS.comments) expect(comment, `comments.${c}`).toHaveProperty(c);
    // guest-authored: guest_id set, host_id null, gif not written by add_comment (D6).
    expect(comment.guest_id).toBe(guestId);
    expect(comment.host_id).toBeNull();

    const dateOption = jsonRow(runSql(`select row_to_json(t) from public.date_options t where t.id = '${dateOptionId}';`));
    for (const c of EXPECTED_COLUMNS.date_options) expect(dateOption, `date_options.${c}`).toHaveProperty(c);

    const question = jsonRow(runSql(`select row_to_json(t) from public.questions t where t.id = '${questionId}';`));
    for (const c of EXPECTED_COLUMNS.questions) expect(question, `questions.${c}`).toHaveProperty(c);

    // The rest: insert one representative row (using guest2Id so the duplicate
    // probes below keep guestId's slots free) and check the columns.
    const reaction = insertReturningJson(
      `insert into public.comment_reactions (comment_id, guest_id, emoji) values ('${commentId}', '${guest2Id}', '🎉')`,
    );
    for (const c of EXPECTED_COLUMNS.comment_reactions) expect(reaction, `comment_reactions.${c}`).toHaveProperty(c);

    const photo = insertReturningJson(
      `insert into public.event_photos (event_id, guest_id, image_url) values ('${eventId}', '${guest2Id}', 'event-photos/x.jpg')`,
    );
    for (const c of EXPECTED_COLUMNS.event_photos) expect(photo, `event_photos.${c}`).toHaveProperty(c);

    const vote = insertReturningJson(
      `insert into public.date_votes (date_option_id, guest_id) values ('${dateOptionId}', '${guest2Id}')`,
    );
    for (const c of EXPECTED_COLUMNS.date_votes) expect(vote, `date_votes.${c}`).toHaveProperty(c);

    const answer = insertReturningJson(
      `insert into public.answers (question_id, guest_id, value) values ('${questionId}', '${guest2Id}', '"yes"'::jsonb)`,
    );
    for (const c of EXPECTED_COLUMNS.answers) expect(answer, `answers.${c}`).toHaveProperty(c);

    const reminder = insertReturningJson(
      `insert into public.scheduled_reminders (event_id, remind_at, channel) values ('${eventId}', now(), 'email')`,
    );
    for (const c of EXPECTED_COLUMNS.scheduled_reminders) expect(reminder, `scheduled_reminders.${c}`).toHaveProperty(c);
    // 🟡 status defaults to 'pending' (SCHEMA §13).
    expect(reminder.status).toBe("pending");

    const broadcast = insertReturningJson(
      `insert into public.broadcasts (event_id, body, channel) values ('${eventId}', 'see you!', 'sms')`,
    );
    for (const c of EXPECTED_COLUMNS.broadcasts) expect(broadcast, `broadcasts.${c}`).toHaveProperty(c);

    const rl = insertReturningJson(
      `insert into public.rate_limits (bucket_key, window_start) values ('probe:cols', now())`,
    );
    for (const c of EXPECTED_COLUMNS.rate_limits) expect(rl, `rate_limits.${c}`).toHaveProperty(c);
    // count defaults to 0 (D14 — atomic upsert + increment).
    expect(rl.count).toBe(0);
  });

  it.skipIf(!LOCAL_UP)("comments: enforces exactly one of guest_id/host_id non-null", () => {
    // both set -> reject
    expect(() =>
      runSql(`insert into public.comments (event_id, guest_id, host_id, body) values ('${eventId}', '${guestId}', '${hostId}', 'x');`),
    ).toThrow();
    // neither set -> reject
    expect(() =>
      runSql(`insert into public.comments (event_id, body) values ('${eventId}', 'x');`),
    ).toThrow();
    // host-authored (host_id only) -> accept
    expect(() =>
      runSql(`insert into public.comments (event_id, host_id, body) values ('${eventId}', '${hostId}', 'from host');`),
    ).not.toThrow();
  });

  it.skipIf(!LOCAL_UP)("questions.type check allows text/single/multi/social and rejects others", () => {
    for (const type of ["text", "single", "multi", "social"]) {
      expect(() =>
        runSql(`insert into public.questions (event_id, prompt, type) values ('${eventId}', 'q', '${type}');`),
        `type='${type}' must be allowed`,
      ).not.toThrow();
    }
    expect(() =>
      runSql(`insert into public.questions (event_id, prompt, type) values ('${eventId}', 'q', 'ranking');`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("channel checks reject non email/sms on scheduled_reminders & broadcasts", () => {
    expect(() =>
      runSql(`insert into public.scheduled_reminders (event_id, remind_at, channel) values ('${eventId}', now(), 'carrier-pigeon');`),
    ).toThrow();
    expect(() =>
      runSql(`insert into public.broadcasts (event_id, body, channel) values ('${eventId}', 'x', 'fax');`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("scheduled_reminders.status check rejects values outside pending/sent/failed", () => {
    expect(() =>
      runSql(`insert into public.scheduled_reminders (event_id, remind_at, channel, status) values ('${eventId}', now(), 'email', 'queued');`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces comment_reactions unique(comment_id, guest_id, emoji)", () => {
    runSql(`insert into public.comment_reactions (comment_id, guest_id, emoji) values ('${commentId}', '${guestId}', '👍');`);
    expect(() =>
      runSql(`insert into public.comment_reactions (comment_id, guest_id, emoji) values ('${commentId}', '${guestId}', '👍');`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces date_votes unique(date_option_id, guest_id)", () => {
    runSql(`insert into public.date_votes (date_option_id, guest_id) values ('${dateOptionId}', '${guestId}');`);
    expect(() =>
      runSql(`insert into public.date_votes (date_option_id, guest_id) values ('${dateOptionId}', '${guestId}');`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("enforces answers unique(question_id, guest_id)", () => {
    runSql(`insert into public.answers (question_id, guest_id, value) values ('${questionId}', '${guestId}', '1'::jsonb);`);
    expect(() =>
      runSql(`insert into public.answers (question_id, guest_id, value) values ('${questionId}', '${guestId}', '2'::jsonb);`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("rate_limits: enforces unique(bucket_key, window_start) (atomic upsert key, D14)", () => {
    runSql(`insert into public.rate_limits (bucket_key, window_start, count) values ('submit:e:ip', timestamptz '2030-01-01 00:00:00+00', 1);`);
    expect(() =>
      runSql(`insert into public.rate_limits (bucket_key, window_start, count) values ('submit:e:ip', timestamptz '2030-01-01 00:00:00+00', 1);`),
    ).toThrow();
  });

  it.skipIf(!LOCAL_UP)("ships with RLS enabled on every new table (绝不削弱 RLS)", () => {
    // RLS is enabled the moment a table exists; full host-isolation + anon-deny
    // assertions live in TEST-SPEC §1.3/§1.4 (the [SECURITY] pass, 1.3/1.4).
    const rows = runSql(
      `select c.relname || '=' || c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in (${ALL_TABLES.map((t) => `'${t}'`).join(",")})
        order by c.relname;`,
    )
      .trim()
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    for (const t of ALL_TABLES) expect(rows, `${t} must have RLS enabled`).toContain(`${t}=true`);
  });

  it.skipIf(!LOCAL_UP)("every new table has at least one policy, none granted to anon/public (G1/I1)", () => {
    // Mirrors the boundary check (护栏 5): each public table must have a policy,
    // and client-data tables must not expose anon/public policies.
    const noPolicy = runSql(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in (${ALL_TABLES.map((t) => `'${t}'`).join(",")})
          and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname);`,
    ).trim();
    expect(noPolicy, "every new table must carry a policy").toBe("");

    const anonPolicies = runSql(
      `select tablename || '.' || policyname from pg_policies
        where schemaname='public' and tablename in (${ALL_TABLES.map((t) => `'${t}'`).join(",")})
          and (roles && array['anon','public']::name[]);`,
    ).trim();
    expect(anonPolicies, "no client-data table may grant anon/public a policy").toBe("");
  });
});
