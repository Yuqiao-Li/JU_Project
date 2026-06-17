import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 5.1 — date-poll UI (the RPC layer it stands on). The voting + finalize RPCs
 * already exist (1.5e / migration 0011); this task adds the two MISSING pieces the
 * UI needs and exercises the loop end-to-end at the RPC boundary (the vitest harness
 * is server-only / @-alias-bound, so behaviour is asserted at the DEFINER boundary,
 * not on rendered HTML):
 *
 *   * get_date_poll(slug, guest_token?)  — the READ path. anon/guest cannot SELECT
 *     date_options/date_votes directly (G1), so the public page's options + live
 *     tally + "my current selection" must arrive through ONE SECURITY DEFINER RPC.
 *     It reuses the shared unlock gate to resolve my_option_ids, and it honours the
 *     private gate (D3): a private event's poll is null to anyone who isn't the owner
 *     or service_role — anon can't read a private poll directly.
 *   * add_date_option / remove_date_option — HOST-ONLY candidate management (增删候选).
 *     authenticated holds SELECT-only on date_options, and the architecture forbids
 *     host-side client DML on child tables, so these are DEFINER + the same host-auth
 *     gate as finalize_date (auth.uid() null ⇒ reject service-role/no-JWT; host_id <>
 *     auth.uid() ⇒ reject a non-owner).
 *
 * Plus the task's two named integration assertions on the EXISTING RPCs:
 *   * vote_dates is a replacing multi-select upsert (去掉未选项).
 *   * finalize_date writes events.starts_at and the votes SURVIVE (保留投票记录).
 *
 * Written adversarially: assume a stranger can add/remove another host's candidates,
 * a service-role cron can manage a poll, anon can read a private event's dates, and a
 * finalize wipes the tally. Seeding is done as the postgres superuser (psql) because
 * with auto-expose OFF anon/service have no API grant on the client-data tables — only
 * the DEFINER RPC reaches them. Gated on a reachable local stack so the file skips
 * (green) without Docker; where the stack is up, the gate must really hold.
 */
const LOCAL_UP = localStackRunning();

const FN_POLL = "get_date_poll";
const FN_ADD = "add_date_option";
const FN_REMOVE = "remove_date_option";
const FN_VOTE = "vote_dates";
const FN_FINALIZE = "finalize_date";

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

/** The IN-parameter names of a function, in order (from pg_proc). */
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

function eventStartsAt(slug: string): string {
  return scalar(runSql(`select coalesce(starts_at::text,'<null>') from public.events where slug='${slug}';`));
}
function eventDateTbd(slug: string): string {
  return scalar(runSql(`select date_tbd from public.events where slug='${slug}';`));
}
/** Count of all date_votes on an event (through its options). */
function eventVoteCount(slug: string): number {
  return Number(
    scalar(
      runSql(
        `select count(*) from public.date_votes dv
           join public.date_options o on o.id=dv.date_option_id
           join public.events e on e.id=o.event_id where e.slug='${slug}';`,
      ),
    ),
  );
}
/** Whether a date_option row still exists. */
function optionExists(id: string): boolean {
  return scalar(runSql(`select count(*) from public.date_options where id='${id}'::uuid;`)) === "1";
}

type ApiResult = { data: unknown; error: { message?: string; code?: string } | null };
type PollOption = { id: string; starts_at: string; ends_at: string | null; votes: number };
type Poll = {
  event_id: string;
  date_tbd: boolean;
  finalized: boolean;
  starts_at: string | null;
  unlocked: boolean;
  options: PollOption[];
  my_option_ids: string[];
};

const PREFIX = "t51"; // cleanup deletes every event whose slug starts here

const E_POLL = "t51-poll"; // public TBD — read path + multi-select upsert
const E_PRIV = "t51-priv"; // private TBD — private gate (D3)
const E_FIN = "t51-fin"; // public TBD — finalize keeps votes
const E_ADD = "t51-add"; // public TBD — host add/remove candidates

// Fixed option ids.
const PO1 = "51a0a000-0000-4000-8000-000000000001"; // E_POLL
const PO2 = "51a0a000-0000-4000-8000-000000000002"; // E_POLL
const PRO1 = "51a0a000-0000-4000-8000-000000000003"; // E_PRIV
const FO1 = "51a0a000-0000-4000-8000-000000000011"; // E_FIN (the chosen one)
const FO2 = "51a0a000-0000-4000-8000-000000000012"; // E_FIN
const AO1 = "51a0a000-0000-4000-8000-000000000021"; // E_ADD seed option (removed in test)

// Fixed tokens.
const T_GOING = "51b0b000-0000-4000-8000-000000000001"; // E_POLL going — primary voter
const T_NOTGO = "51b0b000-0000-4000-8000-000000000002"; // E_POLL not_going — does NOT unlock
const T_FIN = "51b0b000-0000-4000-8000-000000000003"; // E_FIN going — owns the surviving vote
const T_FORGED = "51b0b000-0000-4000-8000-0000000000ff"; // valid uuid, never inserted

describe("task 5.1: date-poll read path + host candidate management + vote/finalize loop", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

  function anon(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  function service(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.serviceRoleKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  async function callPoll(
    client: SupabaseClient,
    slug: string,
    token?: string,
  ): Promise<{ res: ApiResult; poll: Poll | null }> {
    const body: Record<string, unknown> = { slug };
    if (token !== undefined) body.guest_token = token;
    const res = (await client.rpc(FN_POLL, body)) as ApiResult;
    return { res, poll: (res.data as Poll) ?? null };
  }
  async function callVote(
    client: SupabaseClient,
    slug: string,
    token: string,
    optionIds: string[],
  ): Promise<ApiResult> {
    return (await client.rpc(FN_VOTE, { slug, guest_token: token, option_ids: optionIds })) as ApiResult;
  }

  const sortIds = (xs: string[]): string[] => xs.slice().sort();
  const optionIds = (poll: Poll | null): string[] => (poll?.options ?? []).map((o) => o.id).sort();
  const voteOf = (poll: Poll | null, id: string): number =>
    (poll?.options ?? []).find((o) => o.id === id)?.votes ?? -1;

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A, the owner)").toBeTruthy();
    expect(hostB?.id, "need >=2 host sessions (host B, the non-owner branch)").toBeTruthy();

    // Pinned signatures — the host-only mutations take NO caller-supplied actor id (the
    // host is auth.uid()); the read takes (slug, guest_token).
    expect(inArgNames(FN_POLL), "get_date_poll signature is pinned").toEqual(["slug", "guest_token"]);
    expect(inArgNames(FN_ADD), "add_date_option signature is pinned (no host param)").toEqual([
      "event_id",
      "starts_at",
      "ends_at",
    ]);
    expect(inArgNames(FN_REMOVE), "remove_date_option signature is pinned").toEqual(["option_id"]);

    runSql(`delete from public.events where slug like '${PREFIX}%';`);

    runSql(
      `insert into public.events (host_id, slug, title, visibility, status, date_tbd) values
         ('${hostA.id}','${E_POLL}','t51 poll','public', 'published', true),
         ('${hostA.id}','${E_PRIV}','t51 priv','private','published', true),
         ('${hostA.id}','${E_FIN}', 't51 fin', 'public', 'published', true),
         ('${hostA.id}','${E_ADD}', 't51 add', 'public', 'published', true);`,
    );

    runSql(
      `insert into public.date_options (id, event_id, starts_at, ends_at) values
         ('${PO1}', (select id from public.events where slug='${E_POLL}'),'2030-01-01 18:00:00+00','2030-01-01 21:00:00+00'),
         ('${PO2}', (select id from public.events where slug='${E_POLL}'),'2030-02-02 18:00:00+00', null),
         ('${PRO1}',(select id from public.events where slug='${E_PRIV}'),'2030-03-03 18:00:00+00', null),
         ('${FO1}', (select id from public.events where slug='${E_FIN}'), '2031-09-09 18:00:00+00','2031-09-09 21:00:00+00'),
         ('${FO2}', (select id from public.events where slug='${E_FIN}'), '2031-10-10 18:00:00+00', null),
         ('${AO1}', (select id from public.events where slug='${E_ADD}'), '2032-04-04 18:00:00+00', null);`,
    );

    runSql(
      `insert into public.guests (event_id, guest_token, display_name) values
         ((select id from public.events where slug='${E_POLL}'),'${T_GOING}'::uuid,'t51-going'),
         ((select id from public.events where slug='${E_POLL}'),'${T_NOTGO}'::uuid,'t51-notgo'),
         ((select id from public.events where slug='${E_FIN}'), '${T_FIN}'::uuid,  't51-fin-going');`,
    );

    runSql(
      `insert into public.rsvps (event_id, guest_id, status)
         select g.event_id, g.id,
           case g.guest_token
             when '${T_GOING}'::uuid then 'going'
             when '${T_NOTGO}'::uuid then 'not_going'
             when '${T_FIN}'::uuid   then 'going'
           end
         from public.guests g
         where g.guest_token in ('${T_GOING}'::uuid,'${T_NOTGO}'::uuid,'${T_FIN}'::uuid);`,
    );

    // Pre-seed FO1's surviving vote DIRECTLY (not via the RPC) so finalize can be shown
    // to KEEP it.
    runSql(
      `insert into public.date_votes (date_option_id, guest_id)
         select '${FO1}'::uuid, g.id from public.guests g where g.guest_token='${T_FIN}'::uuid;`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where slug like '${PREFIX}%';`);
  });

  // ───────────────────────────── get_date_poll ─────────────────────────────

  it.skipIf(!LOCAL_UP)(
    "get_date_poll returns the event's options with a live vote tally; my_option_ids is empty without a token and reflects the caller's selection once they vote",
    async () => {
      const an = anon();

      // No token: options visible (read-open tally), but no personal selection, not unlocked.
      const base = await callPoll(an, E_POLL);
      expect(base.res.error, JSON.stringify(base.res.error)).toBeNull();
      expect(optionIds(base.poll), "both seeded options are returned").toEqual(sortIds([PO1, PO2]));
      expect(base.poll?.date_tbd, "the poll event is still date_tbd").toBe(true);
      expect(base.poll?.my_option_ids ?? [], "no token ⇒ no personal selection").toEqual([]);
      expect(base.poll?.unlocked, "no token ⇒ not unlocked").toBe(false);
      expect(voteOf(base.poll, PO1), "PO1 starts with no votes").toBe(0);

      // The going guest votes [PO1] — the tally and my_option_ids both move.
      const v = await callVote(an, E_POLL, T_GOING, [PO1]);
      expect(v.error, JSON.stringify(v.error)).toBeNull();

      const after = await callPoll(an, E_POLL, T_GOING);
      expect(after.res.error, JSON.stringify(after.res.error)).toBeNull();
      expect(after.poll?.unlocked, "an RSVP'd guest's token unlocks the poll").toBe(true);
      expect(after.poll?.my_option_ids, "my_option_ids reflects the guest's vote").toEqual([PO1]);
      expect(voteOf(after.poll, PO1), "the live tally counts the vote").toBe(1);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "a not_going / forged token does not unlock the poll and surfaces no personal selection",
    async () => {
      const an = anon();
      const notgo = await callPoll(an, E_POLL, T_NOTGO);
      expect(notgo.res.error, JSON.stringify(notgo.res.error)).toBeNull();
      expect(notgo.poll?.unlocked, "not_going does NOT unlock").toBe(false);
      expect(notgo.poll?.my_option_ids ?? [], "not_going ⇒ no personal selection").toEqual([]);

      const forged = await callPoll(an, E_POLL, T_FORGED);
      expect(forged.poll?.unlocked, "a forged token does NOT unlock").toBe(false);
      expect(forged.poll?.my_option_ids ?? [], "forged ⇒ no personal selection").toEqual([]);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "get_date_poll honours the private gate (D3): anon gets null for a private event's poll; the owner host and service_role can read it",
    async () => {
      const an = await callPoll(anon(), E_PRIV);
      expect(an.res.error ?? null, "private poll is not an error to anon, just empty").toBeNull();
      expect(an.poll, "anon cannot read a PRIVATE event's poll directly (D3)").toBeNull();

      const svc = await callPoll(service(), E_PRIV);
      expect(svc.poll, "service_role (the trusted SSR path) reads the private poll").not.toBeNull();
      expect(optionIds(svc.poll), "service_role sees the private option").toEqual([PRO1]);

      const owner = await callPoll(asHost(hostA.accessToken), E_PRIV);
      expect(owner.poll, "the owning host reads their own private poll").not.toBeNull();
      expect(optionIds(owner.poll), "owner sees the private option").toEqual([PRO1]);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "anon cannot SELECT date_options directly — get_date_poll is the only read path (G1)",
    async () => {
      const sel = await anon().from("date_options").select("*");
      expect((sel.data ?? []).length, "anon direct SELECT on date_options leaks no rows").toBe(0);
    },
  );

  // ───────────────────── add_date_option / remove_date_option ─────────────────────

  it.skipIf(!LOCAL_UP)(
    "add_date_option is host-only: service-role (no auth.uid), a non-owner host, and anon are all rejected; the owning host adds a candidate that then shows in the poll",
    async () => {
      const evId = scalar(runSql(`select id from public.events where slug='${E_ADD}';`));
      const start = "2032-05-05T18:00:00Z";

      const svc = (await service().rpc(FN_ADD, { event_id: evId, starts_at: start, ends_at: null })) as ApiResult;
      expect(svc.error, "service-role add ⇒ rejected (no auth context, D7③)").not.toBeNull();
      expect(svc.error?.code, "rejection is insufficient_privilege (42501)").toBe("42501");

      const other = (await asHost(hostB.accessToken).rpc(FN_ADD, {
        event_id: evId,
        starts_at: start,
        ends_at: null,
      })) as ApiResult;
      expect(other.error, "a non-owner host add ⇒ rejected").not.toBeNull();
      expect(other.error?.code, "rejection is insufficient_privilege (42501)").toBe("42501");

      const an = (await anon().rpc(FN_ADD, { event_id: evId, starts_at: start, ends_at: null })) as ApiResult;
      expect(an.error, "anon add ⇒ rejected (no execute grant)").not.toBeNull();

      const before = scalar(runSql(`select count(*) from public.date_options where event_id='${evId}'::uuid;`));
      expect(before, "no rejected add created an option").toBe("1"); // only the seeded AO1

      const ok = (await asHost(hostA.accessToken).rpc(FN_ADD, {
        event_id: evId,
        starts_at: start,
        ends_at: null,
      })) as ApiResult;
      expect(ok.error, JSON.stringify(ok.error)).toBeNull();

      const poll = await callPoll(asHost(hostA.accessToken), E_ADD);
      expect(poll.poll?.options.length, "the owner's new candidate shows in the poll").toBe(2);
    },
  );

  it.skipIf(!LOCAL_UP)(
    "remove_date_option is host-only: a non-owner host and service-role are rejected; the owning host removes a candidate and it disappears from the poll",
    async () => {
      const other = (await asHost(hostB.accessToken).rpc(FN_REMOVE, { option_id: AO1 })) as ApiResult;
      expect(other.error, "a non-owner host remove ⇒ rejected").not.toBeNull();
      expect(other.error?.code, "rejection is insufficient_privilege (42501)").toBe("42501");
      expect(optionExists(AO1), "the candidate is untouched by a rejected remove").toBe(true);

      const svc = (await service().rpc(FN_REMOVE, { option_id: AO1 })) as ApiResult;
      expect(svc.error, "service-role remove ⇒ rejected (no auth context)").not.toBeNull();
      expect(optionExists(AO1), "the candidate is still untouched").toBe(true);

      const ok = (await asHost(hostA.accessToken).rpc(FN_REMOVE, { option_id: AO1 })) as ApiResult;
      expect(ok.error, JSON.stringify(ok.error)).toBeNull();
      expect(optionExists(AO1), "the owner's removed candidate is gone").toBe(false);
    },
  );

  // ───────────────────── vote_dates (multi-select upsert, task named) ─────────────────────

  it.skipIf(!LOCAL_UP)(
    "vote_dates is a replacing multi-select upsert: [PO1] → [PO1,PO2] → [PO2] drops the de-selected PO1 (去掉未选项)",
    async () => {
      const an = anon();

      await callVote(an, E_POLL, T_GOING, [PO1]);
      let poll = await callPoll(an, E_POLL, T_GOING);
      expect(poll.poll?.my_option_ids, "selection is [PO1]").toEqual([PO1]);

      await callVote(an, E_POLL, T_GOING, [PO1, PO2]);
      poll = await callPoll(an, E_POLL, T_GOING);
      expect(sortIds(poll.poll?.my_option_ids ?? []), "selection grows to [PO1,PO2]").toEqual(sortIds([PO1, PO2]));

      await callVote(an, E_POLL, T_GOING, [PO2]);
      poll = await callPoll(an, E_POLL, T_GOING);
      expect(poll.poll?.my_option_ids, "re-voting a smaller set drops PO1 (去掉未选项)").toEqual([PO2]);
    },
  );

  // ───────────────────── finalize_date (sets starts_at, keeps votes, task named) ─────────────────────

  it.skipIf(!LOCAL_UP)(
    "finalize_date writes events.starts_at from the chosen option, clears date_tbd, and KEEPS the poll's votes (保留投票记录)",
    async () => {
      const evId = scalar(runSql(`select id from public.events where slug='${E_FIN}';`));
      expect(eventVoteCount(E_FIN), "control: E_FIN has its one seeded vote").toBe(1);
      expect(eventStartsAt(E_FIN), "control: E_FIN has no start before finalize").toBe("<null>");

      const r = (await asHost(hostA.accessToken).rpc(FN_FINALIZE, { event_id: evId, option_id: FO1 })) as ApiResult;
      expect(r.error, JSON.stringify(r.error)).toBeNull();

      expect(eventStartsAt(E_FIN), "starts_at written from the chosen option (FO1)").toContain("2031-09-09 18:00:00");
      expect(eventDateTbd(E_FIN), "date_tbd cleared").toBe("f");
      expect(eventVoteCount(E_FIN), "votes survive finalize (保留投票记录)").toBe(1);
    },
  );
});
