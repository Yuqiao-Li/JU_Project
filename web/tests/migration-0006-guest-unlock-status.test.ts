import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.5.0 [SECURITY] — the shared unlock gate `guest_unlock_status`
 * (migration 0006_guest_unlock_status.sql, logical "0005a"; TEST-SPEC §1.5).
 *
 * Written by the INDEPENDENT test agent (never wrote the implementation) with a
 * "assume the gate is too generous" stance. This one helper is the SINGLE source
 * of the yes/no answer every guest-facing RPC reuses (门禁逻辑只此一处, G4), so a
 * bug here silently unlocks the address / guest list / comment-write across THREE
 * RPCs at once. The pinned contract (SCHEMA "guest_unlock_status" + the RPC table,
 * D1/D5/D13) is hammered from every angle:
 *
 *   1. Unlock set is EXACTLY {going, maybe, waitlisted}. `not_going` (a decline)
 *      must NOT unlock, and neither must "holds a token but never RSVP'd" nor
 *      "no token + not logged in".
 *   2. The token is matched SCOPED TO event_id — event A's token is worthless
 *      against event B (cross-event replay yields a miss, not a leak).
 *   3. Account fallback (D1): a logged-in caller is recognised by
 *      guests.user_id = auth.uid() with NO token (cross-device re-auth), but the
 *      account branch is itself scoped to the caller's own uid and still obeys
 *      the unlock set (a not_going account row stays locked).
 *   4. `contact` is NEVER an identity and never leaves the gate — it is not even
 *      an input parameter, and the result body never carries it.
 *   5. RETURN SHAPE on a miss is a ROW, not an empty set: `unlocked` is ALWAYS a
 *      non-null boolean (the whole point of the gate), and a miss leaks no
 *      guest_id/status.
 *
 * Calls go through PostgREST (.rpc) using the real role paths — anon presents a
 * token, an authenticated host session exercises the account branch, service is
 * the trusted SSR path — because auth.uid() only reflects the caller's JWT over
 * that wire, never via a postgres psql seed. Seeding is done as the postgres
 * superuser (psql): with Supabase auto-expose OFF, anon/service have no API grant
 * on guests/rsvps so PostgREST can't INSERT them. Same pattern as the 1.1–1.4
 * suites. Gated on a reachable local stack so the file still skips (green) without
 * Docker; where the stack IS up, the gate must really hold.
 */
const LOCAL_UP = localStackRunning();

const FN = "guest_unlock_status";

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

/** Last non-empty line of psql `-At` output (the value of a single-column row). */
function scalar(out: string): string {
  return out.trim().split("\n").filter(Boolean).pop() ?? "";
}

/**
 * The IN-parameter names of a function, in order. Resolved from pg_proc so the
 * .rpc calls survive whatever spelling the implementer chose, and so the test can
 * positively assert what is (and ISN'T) an input — e.g. `contact` must never be.
 */
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
  // mode 'i' = IN, 'b' = INOUT; OUT params ('o') and the absence of any modes
  // array (all-IN) are handled so we only ever pass real input args.
  return names.filter((_, idx) => modes.length === 0 || modes[idx] === "i" || modes[idx] === "b");
}

// A PostgREST response, structurally — { data, error } is all we read.
type ApiResult = { data: unknown; error: unknown };

/** The gate's pinned return shape: {guest_id, unlocked, status}. */
interface Gate {
  guest_id: string | null;
  unlocked: boolean | null;
  status: string | null;
}

// ── Sentinels — unique enough to prove a specific value never crosses a boundary.
const SLUG_A = "t150-event-a"; // event the tokens belong to
const SLUG_B = "t150-event-b"; // a *different* event (cross-event scope probe)
const TITLE_PREFIX = "t150"; // cleanup deletes every event whose title starts here
const CONTACT = "t150-contact-secret@sentinel.invalid"; // host-only; must never appear

// Fixed guest_token uuids so the cross-event / forged probes are deterministic.
const T_GOING = "15000000-0000-4000-8000-000000000001";
const T_MAYBE = "15000000-0000-4000-8000-000000000002";
const T_WAIT = "15000000-0000-4000-8000-000000000003";
const T_NOTGOING = "15000000-0000-4000-8000-000000000004";
const T_NORSVP = "15000000-0000-4000-8000-000000000005"; // valid token, but no RSVP row
const T_ACCT_A = "15000000-0000-4000-8000-000000000006"; // guest linked to host A's account
const T_ACCT_B = "15000000-0000-4000-8000-000000000007"; // guest linked to host B, not_going
const T_B = "15000000-0000-4000-8000-000000000008"; // token of a guest on event B
const T_FORGED = "15000000-0000-4000-8000-0000000000ff"; // never inserted anywhere

describe("task 1.5.0 [SECURITY]: guest_unlock_status shared gate (TEST-SPEC §1.5)", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

  let eventArg = "event_id"; // resolved from pg_proc in beforeAll
  let tokenArg = "token";
  let eventAId = "";
  let eventBId = "";
  let gGoingId = "";
  let gMaybeId = "";
  let gWaitId = "";
  let gAcctAId = "";

  /** Call the gate over PostgREST as `client`; omit the token to exercise the
   *  account branch (the function defaults token => null, matching a null-token
   *  caller). Returns the raw response + the single normalised {guest_id,…} row. */
  async function callGate(
    client: SupabaseClient,
    eventId: string,
    token: string | null,
  ): Promise<{ res: ApiResult; obj: Gate | null }> {
    const body: Record<string, unknown> = { [eventArg]: eventId };
    if (token !== null) body[tokenArg] = token;
    const res = (await client.rpc(FN, body)) as ApiResult;
    const obj = (Array.isArray(res.data) ? res.data[0] : res.data) as Gate | null;
    return { res, obj };
  }

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
  /** Authenticated path — the caller's JWT, so auth.uid() = host.id inside the gate. */
  function asHost(accessToken: string): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=2 host sessions (host A)").toBeTruthy();
    expect(hostB?.id, "need >=2 host sessions (host B)").toBeTruthy();

    const inArgs = inArgNames(FN);
    // SCHEMA pins the signature as guest_unlock_status(event_id, token); the gate
    // takes EXACTLY those two inputs — anything else (esp. `contact`) is a D1 hole.
    expect(inArgs).toEqual([eventArg, tokenArg]);
    expect(inArgs, "contact must never be an input to the gate (D1)").not.toContain("contact");
    [eventArg, tokenArg] = inArgs;

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where title like '${TITLE_PREFIX}%' or slug like '${TITLE_PREFIX}%';`);

    // Host profiles are auto-created by the auth.users trigger; upsert defensively
    // so the guests.user_id FK is satisfied regardless of trigger timing.
    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't150 host A'), ('${hostB.id}', 't150 host B')
         on conflict (id) do nothing;`,
    );

    eventAId = scalar(
      runSql(
        `with ins as (insert into public.events (host_id, slug, title, visibility, status)
           values ('${hostA.id}', '${SLUG_A}', '${TITLE_PREFIX} Event A', 'public', 'published')
           returning id) select id from ins;`,
      ),
    );
    eventBId = scalar(
      runSql(
        `with ins as (insert into public.events (host_id, slug, title, visibility, status)
           values ('${hostA.id}', '${SLUG_B}', '${TITLE_PREFIX} Event B', 'public', 'published')
           returning id) select id from ins;`,
      ),
    );

    // Guests: one per status on event A (token branch), an account-linked guest for
    // each host (account branch), a tokened guest with NO rsvp, and one on event B.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name, contact, user_id) values
         ('${eventAId}', '${T_GOING}'::uuid,    't150 going',    '${CONTACT}', null),
         ('${eventAId}', '${T_MAYBE}'::uuid,    't150 maybe',    null,         null),
         ('${eventAId}', '${T_WAIT}'::uuid,     't150 wait',     null,         null),
         ('${eventAId}', '${T_NOTGOING}'::uuid, 't150 notgoing', null,         null),
         ('${eventAId}', '${T_NORSVP}'::uuid,   't150 norsvp',   null,         null),
         ('${eventAId}', '${T_ACCT_A}'::uuid,   't150 acctA',    null,         '${hostA.id}'),
         ('${eventAId}', '${T_ACCT_B}'::uuid,   't150 acctB',    null,         '${hostB.id}'),
         ('${eventBId}', '${T_B}'::uuid,        't150 eventB',   null,         null);`,
    );

    // RSVP statuses (T_NORSVP deliberately gets NONE — a held token without an
    // RSVP must not unlock). T_ACCT_B is not_going — account branch must respect it.
    runSql(
      `insert into public.rsvps (event_id, guest_id, status)
         select g.event_id, g.id, case g.guest_token
                  when '${T_GOING}'::uuid    then 'going'
                  when '${T_MAYBE}'::uuid    then 'maybe'
                  when '${T_WAIT}'::uuid     then 'waitlisted'
                  when '${T_NOTGOING}'::uuid then 'not_going'
                  when '${T_ACCT_A}'::uuid   then 'going'
                  when '${T_ACCT_B}'::uuid   then 'not_going'
                  when '${T_B}'::uuid        then 'going'
                end
           from public.guests g
          where g.guest_token in ('${T_GOING}'::uuid,'${T_MAYBE}'::uuid,'${T_WAIT}'::uuid,
                '${T_NOTGOING}'::uuid,'${T_ACCT_A}'::uuid,'${T_ACCT_B}'::uuid,'${T_B}'::uuid);`,
    );

    gGoingId = scalar(runSql(`select id from public.guests where guest_token='${T_GOING}'::uuid;`));
    gMaybeId = scalar(runSql(`select id from public.guests where guest_token='${T_MAYBE}'::uuid;`));
    gWaitId = scalar(runSql(`select id from public.guests where guest_token='${T_WAIT}'::uuid;`));
    gAcctAId = scalar(runSql(`select id from public.guests where guest_token='${T_ACCT_A}'::uuid;`));
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    // ON DELETE CASCADE clears every seeded guest/rsvp with the event.
    runSql(`delete from public.events where title like '${TITLE_PREFIX}%' or slug like '${TITLE_PREFIX}%';`);
  });

  // ── §1.5 bullet 1 — unlock set is EXACTLY {going,maybe,waitlisted}; not_going NO ──
  it.skipIf(!LOCAL_UP)(
    "token hit: going/maybe/waitlisted → unlocked=true (status echoed, guest_id bound); not_going → unlocked=false",
    async () => {
      const an = anon();

      const going = await callGate(an, eventAId, T_GOING);
      expect(going.res.error, JSON.stringify(going.res.error)).toBeNull();
      expect(going.obj?.unlocked, "going must unlock").toBe(true);
      expect(typeof going.obj?.unlocked, "unlocked is always a boolean").toBe("boolean");
      expect(going.obj?.status).toBe("going");
      expect(going.obj?.guest_id, "matched guest_id is returned for authorship binding").toBe(gGoingId);

      const maybe = await callGate(an, eventAId, T_MAYBE);
      expect(maybe.obj?.unlocked, "maybe must unlock").toBe(true);
      expect(maybe.obj?.status).toBe("maybe");
      expect(maybe.obj?.guest_id).toBe(gMaybeId);

      const wait = await callGate(an, eventAId, T_WAIT);
      expect(wait.obj?.unlocked, "waitlisted must unlock").toBe(true);
      expect(wait.obj?.status).toBe("waitlisted");
      expect(wait.obj?.guest_id).toBe(gWaitId);

      // A decline must NOT reveal the address / list — the crux of the gate.
      const decline = await callGate(an, eventAId, T_NOTGOING);
      expect(decline.res.error, JSON.stringify(decline.res.error)).toBeNull();
      expect(decline.obj?.unlocked, "not_going must NOT unlock").toBe(false);
      expect(typeof decline.obj?.unlocked).toBe("boolean");
      expect(decline.obj?.status).toBe("not_going");

      // Trusted SSR path reaches the same gate (service_role has EXECUTE).
      const trusted = await callGate(service(), eventAId, T_GOING);
      expect(trusted.res.error, JSON.stringify(trusted.res.error)).toBeNull();
      expect(trusted.obj?.unlocked, "service_role path must reach the gate too").toBe(true);
    },
  );

  // ── §1.5 bullet 2 — account fallback by user_id (no token), scoped to caller uid ──
  it.skipIf(!LOCAL_UP)(
    "logged-in caller unlocks via guests.user_id=auth.uid() WITHOUT a token; account branch is uid-scoped and obeys the unlock set",
    async () => {
      // Host A, NO token: recognised by their linked guest (cross-device re-auth).
      const aGate = await callGate(asHost(hostA.accessToken), eventAId, null);
      expect(aGate.res.error, JSON.stringify(aGate.res.error)).toBeNull();
      expect(aGate.obj?.unlocked, "host A is unlocked by account link without a token").toBe(true);
      expect(aGate.obj?.status).toBe("going");
      expect(aGate.obj?.guest_id).toBe(gAcctAId);

      // Host B, NO token: their linked guest is not_going → must stay LOCKED. This
      // pins BOTH that the account branch is scoped to the caller's own uid (B is
      // not handed A's going row) AND that not_going-via-account does not unlock.
      const bGate = await callGate(asHost(hostB.accessToken), eventAId, null);
      expect(bGate.res.error, JSON.stringify(bGate.res.error)).toBeNull();
      expect(bGate.obj?.guest_id, "host B resolves to their OWN linked guest, not A's").not.toBe(gAcctAId);
      expect(bGate.obj?.unlocked, "host B's not_going account row must NOT unlock").toBe(false);
      expect(bGate.obj?.status).toBe("not_going");
    },
  );

  // ── §1.5 bullet 3 — token is scoped to event_id (cross-event replay = miss) ──────
  it.skipIf(!LOCAL_UP)(
    "event A's token is worthless against event B (and vice-versa); the same token DOES work on its own event",
    async () => {
      const an = anon();

      // Event A's going token, presented for event B → no match (event_id scope).
      const crossAtoB = await callGate(an, eventBId, T_GOING);
      expect(crossAtoB.res.error, JSON.stringify(crossAtoB.res.error)).toBeNull();
      expect(crossAtoB.obj?.unlocked, "A's token must not unlock event B").toBe(false);
      expect(crossAtoB.obj?.guest_id, "cross-event miss leaks no guest_id").toBeNull();
      expect(crossAtoB.obj?.status).toBeNull();

      // Symmetric: event B's token against event A → also a miss.
      const crossBtoA = await callGate(an, eventAId, T_B);
      expect(crossBtoA.obj?.unlocked, "B's token must not unlock event A").toBe(false);
      expect(crossBtoA.obj?.guest_id).toBeNull();

      // Sanity: the rejection is genuinely about SCOPE — B's token works on B.
      const onOwn = await callGate(an, eventBId, T_B);
      expect(onOwn.obj?.unlocked, "B's token must unlock its own event B").toBe(true);
      expect(onOwn.obj?.status).toBe("going");
    },
  );

  // ── §1.5 bullet 4 (+更狠) — no token / no login / forged / token-without-RSVP ────
  it.skipIf(!LOCAL_UP)(
    "no token + not logged in → locked; forged token → locked; a valid token WITHOUT an RSVP → locked (no guest leaked)",
    async () => {
      const an = anon();

      // No token, anon (not logged in) — only the account branch could match, and
      // there is no account → miss.
      const none = await callGate(an, eventAId, null);
      expect(none.res.error, JSON.stringify(none.res.error)).toBeNull();
      expect(none.obj?.unlocked, "no token + no login must not unlock").toBe(false);
      expect(none.obj?.guest_id).toBeNull();
      expect(none.obj?.status).toBeNull();

      // Forged token that matches no guest → miss, and crucially no guest_id leak.
      const forged = await callGate(an, eventAId, T_FORGED);
      expect(forged.obj?.unlocked, "a forged token must not unlock").toBe(false);
      expect(forged.obj?.guest_id, "a forged token must resolve to NO guest").toBeNull();
      expect(forged.obj?.status).toBeNull();

      // 更狠: a REAL token whose guest never RSVP'd. Holding the credential alone
      // (no going/maybe/waitlisted) must not unlock — "no RSVP" is not in the set.
      const noRsvp = await callGate(an, eventAId, T_NORSVP);
      expect(noRsvp.obj?.unlocked, "a token without any RSVP must not unlock").toBe(false);
      expect(noRsvp.obj?.guest_id, "no RSVP → no match → no guest_id").toBeNull();
      expect(noRsvp.obj?.status).toBeNull();
    },
  );

  // ── §1.5 (更狠, D1) — contact is never identity and never returned ──────────────
  it.skipIf(!LOCAL_UP)(
    "contact never participates: the going guest's host-only contact never appears in the gate's response",
    async () => {
      // gGoing carries the sentinel contact. An unlocking call returns guest_id/
      // unlocked/status ONLY — the contact must not ride along in any form.
      const going = await callGate(anon(), eventAId, T_GOING);
      expect(going.obj?.unlocked).toBe(true);
      expect(JSON.stringify(going.obj), "contact must never appear in the gate result").not.toContain(CONTACT);
      expect(Object.prototype.hasOwnProperty.call(going.obj ?? {}, "contact")).toBe(false);
    },
  );

  // ── §1.5 (更狠) — miss RETURN SHAPE: a row, unlocked a non-null boolean false ────
  it.skipIf(!LOCAL_UP)(
    "miss return shape: exactly {guest_id:null, unlocked:false (non-null boolean), status:null} — a row, not an empty set",
    async () => {
      const miss = await callGate(anon(), eventAId, T_FORGED);
      expect(miss.res.error, JSON.stringify(miss.res.error)).toBeNull();
      const obj = miss.obj;
      // The whole point of the gate: callers read `unlocked`, never NOT FOUND, so
      // a miss is a populated row with unlocked === false (a STRICT boolean), not
      // null/undefined and not zero rows.
      expect(obj, "a miss must still return a row").not.toBeNull();
      expect(typeof obj?.unlocked, "unlocked is ALWAYS a non-null boolean").toBe("boolean");
      expect(obj?.unlocked).toBe(false);
      expect(obj?.guest_id).toBeNull();
      expect(obj?.status).toBeNull();
      // The shape carries exactly the three pinned keys.
      expect(Object.keys(obj ?? {}).sort()).toEqual(["guest_id", "status", "unlocked"]);
    },
  );
});
