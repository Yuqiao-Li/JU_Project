import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infra } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";
// Pure contract modules (zod + types only — no `server-only`, no `@/` alias), so they
// import cleanly under vitest's node env and can be unit-tested without a DB.
import {
  rsvpInputSchema,
  rsvpResultSchema,
  RSVP_STATUSES,
} from "../lib/events/rsvp";
import { loadRsvpRecord, saveRsvpRecord } from "../lib/events/rsvp-storage";

/**
 * Task 2.4b [SECURITY] — RSVP component + guest_token + waitlist (TEST-SPEC §2.4).
 * Written by the INDEPENDENT test agent (never wrote the implementation), stance:
 * "assume the RSVP flow over-shares, hijacks identities, leaks the token, or lets a
 * waitlist/decline reveal the wrong tier".
 *
 * WHY THE BEHAVIOUR ASSERTIONS ARE AT THE RPC/DATA BOUNDARY, NOT THE RENDERED FORM.
 * The 2.4b client stack reads/writes an event through exactly TWO trusted hops:
 *   • POST /api/events/[slug]/rsvp  →  submit_rsvp  (mint/keep token, decide
 *     going-vs-waitlisted under a lock, link user_id, write-limit) — the SECURITY
 *     DEFINER function is the trust boundary, NOT the form.
 *   • GET  /api/events/[slug]?token=…  →  get_event_by_slug(token)  (the poll re-read
 *     that re-reveals the unlocked tier; the SAME trusted-role call SSR makes).
 * `<RsvpForm>` can only POST the accepted intent and `<EventClient>` can only render
 * the façade those hops return — gated on `unlocked`, never synthesised. So the data
 * these RPCs return is a strict SUPERSET of anything the page can show: a field/value
 * ABSENT here can never appear in the page, and the guest_token the form holds is only
 * ever the value submit_rsvp legitimately returns. Asserting on the RPC payloads is
 * therefore STRICTER than grepping the DOM (and the vitest node env can't render the
 * client components anyway: they import via `@/…` and pull `server-only`). This mirrors
 * the 2.4a suite's rationale; 2.4b adds the *token-lifecycle*, *waitlist-unlock*,
 * *edit/re-lock*, and *write-path contact* angles 2.4a did not cover.
 *
 * Roles are real PostgREST paths: `service()` is the trusted SSR/poll hop; `anon()` is
 * the bypass an attacker tries (hitting the RPC directly to skip the Next route).
 * Seeding is done as the postgres superuser (psql) since anon/service hold no direct
 * table grant — same pattern as the 1.5x / 2.4a suites. Gated on a reachable local
 * stack so the file skips green without Docker; where the stack IS up, the gate holds.
 *
 * Coverage vs TEST-SPEC §2.4 (RSVP half):
 *   • token lifecycle — a fresh submit returns the guest's OWN token + confirmed
 *     status (D15); the token-bearing re-read flips to unlocked (full address in).
 *   • shareable surface — the minted token never appears in the SSR façade, the
 *     unlocked re-read body, or the guest list (token lives only in the submit return
 *     value + localStorage).
 *   • waitlist — a full event records a 'going' request as 'waitlisted'; the page
 *     façade reports full; the waitlisted guest STILL unlocks the address (it is in the
 *     unlock set) yet is NOT on the public Going/Maybe list.
 *   • return-visit edit — an edit reuses the token (no duplicate guest); editing to a
 *     decline RE-LOCKS the address at the data layer (tiering is a data fact).
 *   • contact — collected by the form's optional field but host-only: never in the
 *     confirmation, the façade, or the list.
 *   • private convergence — a guest may RSVP to a private event, but a direct anon
 *     re-read still returns NULL even with a valid token; only the trusted hop resolves it.
 *   • host-only — rsvp_enabled=false refuses a guest submit at the data layer.
 */
const LOCAL_UP = localStackRunning();

const FN_RSVP = "submit_rsvp";
const FN_SLUG = "get_event_by_slug";
const FN_LIST = "get_guest_list";

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

type ApiResult = { data: unknown; error: unknown };
type EventObj = Record<string, unknown> | null;

// ── Fixtures (prefix t24b so they never collide with the demo seed or 2.4a's t24a).
const PREFIX = "t24b";
const SLUG_OPEN = "t24b-open"; // public, capacity 10 — fresh submit → unlock → contact
const SLUG_FULL = "t24b-full"; // public, capacity 1, one seat taken — waitlist case
const SLUG_EDIT = "t24b-edit"; // public, capacity 10 — submit then edit / re-lock
const SLUG_PRIV = "t24b-private"; // private, published — RSVP-to-private convergence
const SLUG_RSVPOFF = "t24b-rsvp-off"; // public, rsvp_enabled=false — host-only

const SENTINEL_ADDR = "t24b-FULL-ADDRESS-77-Token-Lane-SENTINEL"; // location_text (2nd tier)
const SENTINEL_URL = "https://t24b-venue-secret.invalid/map"; // location_url (2nd tier)
const SENTINEL_CONTACT = "t24b-guest-secret@sentinel.invalid"; // 3rd tier — NEVER appears
const CITY = "t24b-Brooklyn"; // location_city (1st tier — MAY appear)

// The going guest that fills SLUG_FULL's single seat (so a fresh going request waitlists).
const T_SEAT = "24b00000-0000-4000-8000-000000000001";
const SEAT_NAME = "t24b-seat-taken";

/** Own-key check that doesn't trip on inherited props — used for "key OMITTED". */
function hasKey(obj: EventObj, key: string): boolean {
  return obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Third-tier fields must never appear in ANY guest-reachable shape (第三类). */
function assertNoThirdTier(data: unknown, label: string): void {
  const json = JSON.stringify(data ?? {});
  expect(json, `${label}: host-only contact must never ride along`).not.toContain(SENTINEL_CONTACT);
  const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as EventObj) : null;
  expect(hasKey(obj, "contact"), `${label}: contact must never be a key`).toBe(false);
  expect(hasKey(obj, "view_password_hash"), `${label}: raw hash must never leak`).toBe(false);
  expect(hasKey(obj, "user_id"), `${label}: no guest user_id in the read path`).toBe(false);
}

describe("task 2.4b [SECURITY]: RSVP + token + waitlist (TEST-SPEC §2.4)", () => {
  const i = infra();
  const hostA = i.hosts[0];

  function anon(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.anonKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  /** The TRUSTED SSR / poll hop — the page/route's service-role client. */
  function service(): SupabaseClient {
    return createClient(i.supabaseUrl as string, i.serviceRoleKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** Reproduce the submit Route Handler's effective call: anon → submit_rsvp. */
  async function submit(
    client: SupabaseClient,
    args: {
      slug: string;
      display_name: string;
      status?: string;
      guest_token?: string;
      plus_ones?: number;
      contact?: string;
      client_fingerprint?: string;
    },
  ): Promise<{ res: ApiResult; data: Record<string, unknown> | null }> {
    const res = (await client.rpc(FN_RSVP, args)) as ApiResult;
    return { res, data: (res.data as Record<string, unknown> | null) ?? null };
  }

  /** Reproduce the poll re-read: get_event_by_slug(slug, token?). */
  async function read(
    client: SupabaseClient,
    slug: string,
    token?: string,
  ): Promise<{ res: ApiResult; data: EventObj }> {
    const body: Record<string, unknown> = { slug };
    if (token !== undefined) body.guest_token = token;
    const res = (await client.rpc(FN_SLUG, body)) as ApiResult;
    return { res, data: (res.data as EventObj) ?? null };
  }

  /** Reproduce the list read: get_guest_list(slug, token?). */
  async function guestList(
    client: SupabaseClient,
    slug: string,
    token?: string,
  ): Promise<{ res: ApiResult; rows: Array<Record<string, unknown>> }> {
    const body: Record<string, unknown> = { slug };
    if (token !== undefined) body.guest_token = token;
    const res = (await client.rpc(FN_LIST, body)) as ApiResult;
    const rows = (res.data as Array<Record<string, unknown>> | null) ?? [];
    return { res, rows };
  }

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);
    expect(hostA?.id, "need >=1 host session (host A)").toBeTruthy();

    // Idempotent reset (slug is UNIQUE — a stale row would break the insert).
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);

    runSql(
      `insert into public.profiles (id, display_name)
         values ('${hostA.id}', 't24b host A')
         on conflict (id) do nothing;`,
    );

    // Events. All carry the SAME sentinel address/url/city so a leak is unambiguous.
    runSql(
      `insert into public.events
         (host_id, slug, title, description, cover_image_url, visibility, status,
          capacity, rsvp_enabled, location_text, location_url, location_city) values
         ('${hostA.id}','${SLUG_OPEN}','t24b Open','open desc','https://cover/open.png','public','published',10,true,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}'),
         ('${hostA.id}','${SLUG_FULL}','t24b Full','full desc','https://cover/full.png','public','published',1,true,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}'),
         ('${hostA.id}','${SLUG_EDIT}','t24b Edit','edit desc','https://cover/edit.png','public','published',10,true,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}'),
         ('${hostA.id}','${SLUG_PRIV}','t24b Private','priv desc','https://cover/priv.png','private','published',10,true,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}'),
         ('${hostA.id}','${SLUG_RSVPOFF}','t24b RSVP Off','off desc','https://cover/off.png','public','published',10,false,'${SENTINEL_ADDR}','${SENTINEL_URL}','${CITY}');`,
    );

    // Fill SLUG_FULL's only seat with a pre-seeded going guest, so a fresh 'going'
    // request must waitlist. This guest also proves the going/maybe list IS rendered
    // for an unlocked caller while the waitlisted newcomer is not.
    runSql(
      `insert into public.guests (event_id, guest_token, display_name)
         values ((select id from public.events where slug='${SLUG_FULL}'), '${T_SEAT}'::uuid, '${SEAT_NAME}');`,
    );
    runSql(
      `insert into public.rsvps (event_id, guest_id, status, plus_ones)
         select g.event_id, g.id, 'going', 0
         from public.guests g where g.guest_token = '${T_SEAT}'::uuid;`,
    );
  });

  afterAll(() => {
    if (!LOCAL_UP) return;
    runSql(`delete from public.events where title like '${PREFIX}%' or slug like '${PREFIX}%';`);
  });

  // ── §2.4 token lifecycle — fresh submit returns OWN token + confirmed status; the
  // token-bearing re-read flips to unlocked (full address appears, D15) ────────────
  it.skipIf(!LOCAL_UP)(
    "a fresh anon submit returns the guest's own token + confirmed status, and the token re-read unlocks the address",
    async () => {
      // Before any RSVP, the SSR render (trusted role, NO token) is first-tier only.
      const before = await read(service(), SLUG_OPEN);
      expect(before.data?.unlocked, "pre-RSVP SSR ⇒ locked").toBe(false);
      expect(hasKey(before.data, "location_text"), "pre-RSVP ⇒ no address key").toBe(false);
      expect(JSON.stringify(before.data), "pre-RSVP SSR body has no address sentinel").not.toContain(SENTINEL_ADDR);

      // The guest RSVPs via the anon write path (no account, no token yet) — real flow.
      const s = await submit(anon(), {
        slug: SLUG_OPEN,
        display_name: "t24b fresh guest",
        status: "going",
        client_fingerprint: "t24b-lifecycle",
      });
      expect(s.res.error, JSON.stringify(s.res.error)).toBeNull();
      expect(s.data?.status, "a non-full event accepts the RSVP as going").toBe("going");
      expect(s.data?.waitlisted, "not waitlisted on an open event").toBe(false);

      // submit_rsvp is the ONE legitimate place a token is returned (to store in
      // localStorage). It must be a usable token we can then unlock with (D15).
      const token = s.data?.guest_token;
      expect(typeof token, "submit_rsvp returns the guest's own token").toBe("string");
      expect((token as string).length, "a real, non-empty token").toBeGreaterThan(0);

      // The client re-reads with that token (poll route ?token=…): now the address is in.
      const after = await read(service(), SLUG_OPEN, token as string);
      expect(after.data?.unlocked, "post-RSVP token re-read ⇒ unlocked").toBe(true);
      expect(after.data?.location_text, "完成 RSVP 后 ⇒ 返回 location_text").toBe(SENTINEL_ADDR);
      expect(after.data?.location_url).toBe(SENTINEL_URL);
      assertNoThirdTier(after.data, "lifecycle-unlocked");
    },
  );

  // ── §2.4 — the minted guest_token never appears in any shareable surface ─────────
  it.skipIf(!LOCAL_UP)(
    "the minted token is absent from the SSR façade, the unlocked re-read body, and the guest list",
    async () => {
      const s = await submit(anon(), {
        slug: SLUG_OPEN,
        display_name: "t24b token-hider",
        status: "going",
        client_fingerprint: "t24b-tokenhide",
      });
      expect(s.res.error, JSON.stringify(s.res.error)).toBeNull();
      const token = s.data?.guest_token as string;
      expect(typeof token).toBe("string");

      // The SSR render uses NO token and must not surface anyone's token.
      const ssr = await read(service(), SLUG_OPEN);
      expect(hasKey(ssr.data, "guest_token"), "no guest_token key in the SSR body").toBe(false);
      expect(JSON.stringify(ssr.data), "SSR body never echoes a token value").not.toContain(token);

      // Even the UNLOCKED re-read (which is GIVEN the token as input) must not REFLECT
      // it back into the body — the body is shareable, the input is not.
      const unlocked = await read(service(), SLUG_OPEN, token);
      expect(unlocked.data?.unlocked, "going token unlocks").toBe(true);
      expect(hasKey(unlocked.data, "guest_token"), "unlocked body still has no token key").toBe(false);
      expect(JSON.stringify(unlocked.data), "unlocked body does not echo the token").not.toContain(token);

      // The guest list this guest can now see must not leak ANY token / guest_id either.
      const list = await guestList(service(), SLUG_OPEN, token);
      expect(list.res.error, JSON.stringify(list.res.error)).toBeNull();
      const listJson = JSON.stringify(list.rows);
      expect(listJson, "the guest list never echoes a token").not.toContain(token);
      for (const row of list.rows) {
        expect(hasKey(row, "guest_token"), "list row has no token").toBe(false);
        expect(hasKey(row, "guest_id"), "list row has no guest_id").toBe(false);
        expect(hasKey(row, "id"), "list row has no row id").toBe(false);
        expect(hasKey(row, "contact"), "list row has no contact").toBe(false);
      }
    },
  );

  // ── §2.4 waitlist — full event records 'going' as 'waitlisted'; the façade is full;
  // the waitlisted guest STILL unlocks the address but is NOT on the Going/Maybe list ─
  it.skipIf(!LOCAL_UP)(
    "a full event: a going request is recorded waitlisted, the façade is full, and the waitlisted guest unlocks the address yet stays off the public list",
    async () => {
      // The page renders "Full — join the waitlist" off this façade: capacity 1, the
      // single seat already taken ⇒ remaining 0 (this is what drives isFull).
      const facade = await read(service(), SLUG_FULL);
      expect(facade.data?.going_count, "one going seat occupied").toBe(1);
      expect(facade.data?.capacity_remaining, "capacity 1 − occupancy 1 ⇒ 0 (full)").toBe(0);

      // A fresh guest RSVPs 'going' on a full event ⇒ the record is forced waitlisted.
      const s = await submit(anon(), {
        slug: SLUG_FULL,
        display_name: "t24b overflow",
        status: "going",
        client_fingerprint: "t24b-overflow",
      });
      expect(s.res.error, JSON.stringify(s.res.error)).toBeNull();
      expect(s.data?.status, "full ⇒ confirmed status is waitlisted, not going").toBe("waitlisted");
      expect(s.data?.waitlisted, "the waitlisted flag is set (drives the waitlist copy)").toBe(true);
      const wlToken = s.data?.guest_token as string;

      // A waitlisted RSVP does NOT consume a seat — the façade stays full.
      const after = await read(service(), SLUG_FULL);
      expect(after.data?.going_count, "a waitlisted RSVP does not increase going_count").toBe(1);
      expect(after.data?.capacity_remaining, "still full after the waitlisted RSVP").toBe(0);

      // SHARP: 'waitlisted' is in the unlock set (D5) — a waitlisted guest must still
      // SEE where it is, so a spot can open up and they can show.
      const wlRead = await read(service(), SLUG_FULL, wlToken);
      expect(wlRead.data?.unlocked, "waitlisted token still unlocks (it is in the unlock set)").toBe(true);
      expect(wlRead.data?.location_text, "a waitlisted guest sees the full address").toBe(SENTINEL_ADDR);

      // …but the public Going/Maybe list must NOT include the waitlisted newcomer; the
      // pre-seeded GOING guest IS on it (the list still renders for an unlocked caller).
      const list = await guestList(service(), SLUG_FULL, wlToken);
      const names = list.rows.map((r) => r.display_name);
      const statuses = list.rows.map((r) => r.status);
      expect(names, "the going guest is on the public list").toContain(SEAT_NAME);
      expect(names, "the waitlisted newcomer is NOT on the public list").not.toContain("t24b overflow");
      expect(statuses, "no waitlisted row ever appears on the public list").not.toContain("waitlisted");
      assertNoThirdTier(list.rows, "waitlist-list");
    },
  );

  // ── §2.4 return visit — an edit reuses the token (no duplicate); a decline RE-LOCKS
  // the address at the DATA layer (strict tiering is a data fact, never CSS) ────────
  it.skipIf(!LOCAL_UP)(
    "editing with the same token updates in place (no duplicate guest); editing to a decline re-locks the address",
    async () => {
      const an = anon();
      const first = await submit(an, {
        slug: SLUG_EDIT,
        display_name: "t24b returner",
        status: "going",
        client_fingerprint: "t24b-edit-1",
      });
      expect(first.res.error, JSON.stringify(first.res.error)).toBeNull();
      const token = first.data?.guest_token as string;
      const guestId = first.data?.guest_id as string;
      expect(typeof token).toBe("string");

      // Going ⇒ unlocked, address visible (the returning-guest unlock the form relies on).
      const unlocked = await read(service(), SLUG_EDIT, token);
      expect(unlocked.data?.unlocked, "going ⇒ unlocked").toBe(true);
      expect(unlocked.data?.location_text).toBe(SENTINEL_ADDR);

      // Edit to a DECLINE reusing the SAME token (复访可改): must update the SAME guest…
      const edit = await submit(an, {
        slug: SLUG_EDIT,
        display_name: "t24b returner",
        status: "not_going",
        guest_token: token,
      });
      expect(edit.res.error, JSON.stringify(edit.res.error)).toBeNull();
      expect(edit.data?.status, "the decline is recorded").toBe("not_going");
      expect(edit.data?.guest_id, "same guest row (an edit, never a new guest)").toBe(guestId);
      expect(edit.data?.guest_token, "the token is preserved across the edit").toBe(token);

      // No duplicate guest was created for this event (the edit reused the row).
      const count = runSql(
        `select count(*) from public.guests g
           join public.events e on e.id = g.event_id
          where e.slug = '${SLUG_EDIT}';`,
      ).trim();
      expect(count, "exactly one guest row for this event after the edit").toBe("1");

      // SHARP: a decline is NOT in the unlock set — the very next poll re-read with the
      // same token must RE-LOCK; the address is gone at the data layer, not just hidden.
      const relocked = await read(service(), SLUG_EDIT, token);
      expect(relocked.data?.unlocked, "not_going ⇒ no longer unlocked").toBe(false);
      expect(hasKey(relocked.data, "location_text"), "decline ⇒ address key omitted again").toBe(false);
      expect(JSON.stringify(relocked.data), "decline ⇒ no address sentinel").not.toContain(SENTINEL_ADDR);

      // Changing one's mind back to going re-unlocks with the SAME token (idempotent).
      const back = await submit(an, {
        slug: SLUG_EDIT,
        display_name: "t24b returner",
        status: "going",
        guest_token: token,
      });
      expect(back.data?.guest_id, "still the same guest").toBe(guestId);
      const reUnlocked = await read(service(), SLUG_EDIT, token);
      expect(reUnlocked.data?.unlocked, "going again ⇒ unlocked again").toBe(true);
      expect(reUnlocked.data?.location_text).toBe(SENTINEL_ADDR);
    },
  );

  // ── §2.4 — the optional contact field is host-only metadata, never echoed back ───
  it.skipIf(!LOCAL_UP)(
    "a contact submitted via the form is host-only: absent from the confirmation, the unlocked façade, and the guest list",
    async () => {
      const s = await submit(anon(), {
        slug: SLUG_OPEN,
        display_name: "t24b contact-guest",
        status: "going",
        contact: SENTINEL_CONTACT,
        client_fingerprint: "t24b-contact",
      });
      expect(s.res.error, JSON.stringify(s.res.error)).toBeNull();
      const token = s.data?.guest_token as string;

      // D15: the confirmation is ONLY the guest's own token + status — never the contact.
      expect(JSON.stringify(s.data), "the RSVP confirmation never echoes the contact").not.toContain(SENTINEL_CONTACT);
      expect(hasKey(s.data, "contact"), "confirmation has no contact key").toBe(false);

      // The unlocked re-read façade (third tier) — contact must never ride along.
      const unlocked = await read(service(), SLUG_OPEN, token);
      expect(unlocked.data?.unlocked, "the contact-guest is unlocked").toBe(true);
      assertNoThirdTier(unlocked.data, "contact-facade");

      // The guest list — contact must never appear there either.
      const list = await guestList(service(), SLUG_OPEN, token);
      expect(JSON.stringify(list.rows), "the guest list never carries a contact").not.toContain(SENTINEL_CONTACT);
      assertNoThirdTier(list.rows, "contact-list");

      // Sanity: the contact WAS stored (host-side), so this isn't a false pass from a
      // dropped write — the superuser (a host-equivalent path) can see it.
      const stored = runSql(
        `select contact from public.guests where guest_token = '${token}'::uuid;`,
      ).trim();
      expect(stored, "the contact is persisted for the host, just never on a guest path").toBe(SENTINEL_CONTACT);
    },
  );

  // ── §2.4 — a guest may RSVP to a PRIVATE event, but the re-read converges to the
  // trusted hop: a direct anon read still returns NULL even WITH a valid token ──────
  it.skipIf(!LOCAL_UP)(
    "private event: a guest can RSVP, but only the trusted hop re-reads the unlock — anon get_event_by_slug stays NULL even with a valid token",
    async () => {
      // Link-private: a guest who has the link CAN submit. The write path doesn't gate
      // on visibility — only the READ does.
      const s = await submit(anon(), {
        slug: SLUG_PRIV,
        display_name: "t24b private guest",
        status: "going",
        client_fingerprint: "t24b-priv",
      });
      expect(s.res.error, JSON.stringify(s.res.error)).toBeNull();
      expect(s.data?.status, "the private RSVP is accepted as going").toBe("going");
      const token = s.data?.guest_token as string;
      expect(typeof token).toBe("string");

      // The attacker re-reads DIRECTLY with the anon key, skipping the Next poll route —
      // and even WITH their genuinely-unlocking token the private role gate returns NULL
      // (the gate precedes, and is independent of, the unlock gate).
      const anonRead = await read(anon(), SLUG_PRIV, token);
      expect(anonRead.res.error, JSON.stringify(anonRead.res.error)).toBeNull();
      expect(anonRead.data, "anon must get NULL for a private slug even with a valid token").toBeNull();

      // anon can't reach the private event off the base table either (no anon policy).
      const direct = (await anon().from("events").select("slug").eq("slug", SLUG_PRIV)) as ApiResult;
      const rows = (direct.data as unknown[] | null) ?? [];
      expect(
        direct.error !== null || rows.length === 0,
        "anon direct SELECT on a private event must be empty/denied",
      ).toBe(true);

      // Only the trusted hop (service_role, what the poll route uses) resolves it — and
      // with the token, it unlocks the address. This is the ONLY path the page re-reads.
      const trusted = await read(service(), SLUG_PRIV, token);
      expect(trusted.data, "service_role (the poll hop) resolves the private event").not.toBeNull();
      expect(trusted.data?.unlocked, "with the token the trusted re-read unlocks").toBe(true);
      expect(trusted.data?.location_text, "the private guest sees the address only via the trusted hop").toBe(SENTINEL_ADDR);
      assertNoThirdTier(trusted.data, "private-unlocked");
    },
  );

  // ── §2.4 / D6 — rsvp_enabled=false is host-only: a guest submit is refused at the DB.
  it.skipIf(!LOCAL_UP)(
    "rsvp_enabled=false: a guest submit is refused at the data layer (the form shows no input — host-only)",
    async () => {
      const s = await submit(anon(), {
        slug: SLUG_RSVPOFF,
        display_name: "t24b should-not-rsvp",
        status: "going",
        client_fingerprint: "t24b-off",
      });
      expect(s.res.error, "a disabled event must reject the guest RSVP").not.toBeNull();
      expect(s.data, "no RSVP record is returned for a disabled event").toBeNull();

      // And no guest row leaked through for this event.
      const count = runSql(
        `select count(*) from public.guests g
           join public.events e on e.id = g.event_id
          where e.slug = '${SLUG_RSVPOFF}';`,
      ).trim();
      expect(count, "a disabled event has no guest rows from the refused submit").toBe("0");
    },
  );
});

// ── Contract units — the input/result schemas the form + Route Handler both rely on.
// These need NO database (pure zod), so they run even without Docker: the boundary
// must reject a forged/invalid intent BEFORE it ever reaches submit_rsvp.
describe("task 2.4b: RSVP input/result contract (no DB)", () => {
  it("rsvpInputSchema accepts a minimal valid intent and a returning-guest edit", () => {
    const fresh = rsvpInputSchema.safeParse({ display_name: "Alex", status: "going" });
    expect(fresh.success, JSON.stringify(fresh.error?.issues)).toBe(true);
    if (fresh.success) expect(fresh.data.plus_ones, "plus_ones defaults to 0").toBe(0);

    const editing = rsvpInputSchema.safeParse({
      display_name: "Alex",
      status: "maybe",
      plus_ones: 2,
      contact: "alex@example.com",
      guest_token: "24b00000-0000-4000-8000-0000000000aa",
    });
    expect(editing.success, JSON.stringify(editing.error?.issues)).toBe(true);
  });

  it("rsvpInputSchema rejects 'waitlisted' as a REQUESTED status (it is a server outcome only)", () => {
    // The form only offers going/maybe/not_going; waitlisted is decided by submit_rsvp's
    // capacity lock and can never be asked for by a client.
    expect(rsvpInputSchema.safeParse({ display_name: "A", status: "waitlisted" }).success).toBe(false);
    expect(rsvpInputSchema.safeParse({ display_name: "A", status: "going-ish" }).success).toBe(false);
    expect([...RSVP_STATUSES], "the offered statuses are exactly the three intents").toEqual([
      "going",
      "maybe",
      "not_going",
    ]);
  });

  it("rsvpInputSchema requires a non-empty name and rejects a malformed (non-uuid) token", () => {
    expect(rsvpInputSchema.safeParse({ display_name: "", status: "going" }).success).toBe(false);
    expect(rsvpInputSchema.safeParse({ display_name: "   ", status: "going" }).success).toBe(false);
    // A client-chosen token can at most match an existing event-scoped guest — a
    // malformed one is refused at the boundary before it ever reaches the RPC.
    const bad = rsvpInputSchema.safeParse({ display_name: "A", status: "going", guest_token: "not-a-uuid" });
    expect(bad.success, "a non-uuid token shape is rejected").toBe(false);
  });

  it("rsvpInputSchema bounds plus_ones (server still re-clamps) and over-long fields", () => {
    expect(rsvpInputSchema.safeParse({ display_name: "A", status: "going", plus_ones: -1 }).success).toBe(false);
    expect(rsvpInputSchema.safeParse({ display_name: "A", status: "going", plus_ones: 999 }).success).toBe(false);
    expect(rsvpInputSchema.safeParse({ display_name: "x".repeat(200), status: "going" }).success).toBe(false);
  });

  it("rsvpResultSchema demands the D15 confirmation shape (own token + a waitlisted flag)", () => {
    const ok = rsvpResultSchema.safeParse({
      event_id: "e",
      guest_id: "g",
      guest_token: "t",
      status: "waitlisted",
      plus_ones: 0,
      waitlisted: true,
    });
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);

    // A payload missing the token can never reach the client as a confirmation.
    expect(
      rsvpResultSchema.safeParse({ event_id: "e", guest_id: "g", status: "going", plus_ones: 0, waitlisted: false })
        .success,
    ).toBe(false);
    // …nor one missing the authoritative waitlisted flag.
    expect(
      rsvpResultSchema.safeParse({ event_id: "e", guest_id: "g", guest_token: "t", status: "going", plus_ones: 0 })
        .success,
    ).toBe(false);
  });

  it("the localStorage token cache is SSR-safe: no read/write happens without a browser", () => {
    // Under the node test env there is no browser global, so the token cache is inert —
    // the credential is never read or written server-side (it lives only client-side).
    expect(loadRsvpRecord("t24b-open"), "no cached record server-side").toBeNull();
    expect(
      () =>
        saveRsvpRecord("t24b-open", {
          token: "t",
          status: "going",
          plus_ones: 0,
          display_name: "A",
          contact: null,
        }),
      "persisting is a safe no-op when there is no browser",
    ).not.toThrow();
  });
});
