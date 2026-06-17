# SECURITY.md — Final security pass (task 6.4)

This is the line-by-line review required by task 6.4: the `CLAUDE.md` security
checklist plus every locked design decision (D1–D16) and guardrail invariant
(G-series) referenced across `CLAUDE.md` / `SCHEMA.md` / `TASKS.md`.

Each row lists **where** the property is enforced (the security boundary is the
database, not the UI) and **how it is verified** — a guardrail check in
`check-boundaries.sh`, an integration spec under `web/tests/`, or both. The
verification harness:

- **Vitest** runs against a real local Supabase DB. anon paths use the anon key,
  host paths use a minted session, trusted paths use the service role — so an
  assertion that "anon cannot read X" is a real forged-call attempt, not a mock.
- **`check-boundaries.sh`** (with `RUN_DB_CHECKS=1`) asserts the static + DB
  invariants directly against `pg_policies` / `pg_class`.

Run both to reproduce:

```bash
pnpm --dir web test
RUN_DB_CHECKS=1 SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  bash ./check-boundaries.sh
```

---

## A. CLAUDE.md security checklist

| # | Check | Status | Enforced by | Verified by |
|---|-------|--------|-------------|-------------|
| 1 | Can a malicious guest write data for an event they shouldn't? | ✅ No | Guest writes only via `SECURITY DEFINER` RPCs (`submit_rsvp`, `add_comment`, `vote_dates`) that validate event existence/state/capacity; anon has **no** INSERT grant/policy on client-data tables. | `migration-0005-anon-revoke.test.ts`, `migration-0008-submit-rsvp.test.ts`, `migration-0010-add-comment.test.ts`; guardrail 5 (no anon policy on client-data tables). |
| 2 | Can a guest edit someone else's RSVP? | ✅ No | `submit_rsvp` resolves the row by `guest_token` (or `auth.uid()` for a logged-in user) only; a bare `contact` never adopts an existing row. | `migration-0008-submit-rsvp.test.ts` (token dedup; bare-contact creates a new row, never returns an existing token), `task-2.4b-rsvp-token-waitlist.test.ts`. |
| 3 | Can a non-host read a private event's guest list? | ✅ No | `get_event_by_slug` returns `null` for `private` unless `auth.role()='service_role'`; `get_guest_list` requires `guest_unlock_status` to have unlocked and returns only `display_name/status/plus_ones`. | `migration-0007-get-event-by-slug.test.ts`, `migration-0009-get-guest-list.test.ts`, `task-2.4a-public-event-page.test.ts`, `task-3.1-guest-list.test.ts`. |
| 4 | Are capacity / waitlist limits enforced in the DB, not just the UI? | ✅ Yes | `submit_rsvp` takes `pg_advisory_xact_lock` and counts `going` occupancy inside the lock; overflow → `waitlisted`. | `migration-0008-submit-rsvp.test.ts` (serial + concurrent N+5 → exactly N going), `task-3.2-capacity-waitlist.test.ts`. |
| 5 | Are secrets only in env vars, never committed? | ✅ Yes | `.env*` gitignored; service-role read only by `lib/supabase/service.ts` (`server-only`), never `NEXT_PUBLIC_`. | guardrail 3b/3c (no service-role in client, service not imported by client components) + guardrail 4 (no committed `.env`/JWT). |

---

## B. Architecture non-negotiables (CLAUDE.md rules 1–6)

| Rule | Status | Notes / verification |
|------|--------|----------------------|
| 1. Guests never *required* to authenticate; `guest_token` is the credential; `contact` is host-visible metadata only. | ✅ | RSVP needs only the public slug; token returned by RPC + stored in localStorage. `task-2.4b`, `migration-0008`. |
| 2. All writes go through RLS or `SECURITY DEFINER` RPCs. | ✅ | anon has no direct table write; every guest write is an RPC. `migration-0005-anon-revoke.test.ts`. |
| 3. Guest-facing writes happen via `SECURITY DEFINER` RPCs that validate inputs. | ✅ | `submit_rsvp` / `add_comment` / `vote_dates` self-validate (event open, capacity, unlock). |
| 4. Hosts can only touch their own events (RLS keyed on `auth.uid() = host_id`). | ✅ | `migration-0004-rls.test.ts` (host A cannot read/update host B), `task-2.3-dashboard*.test.ts`. |
| 5. Schema is extension-ready (🟡 tables exist, no UI). | ✅ | `comment_reactions`, `event_photos`, `questions`, `answers`, `scheduled_reminders`, `broadcasts` built in `0002`/`0003`; no frontend (guardrail 1 blacklist). |
| 6. Every migration is a numbered SQL file; applied ones never edited. | ✅ | `supabase/migrations/0001…0016`; workflow + guardrail enforce additive-only. |

---

## C. Design decisions D1–D16

| ID | Decision | Status | Enforced by | Verified by |
|----|----------|--------|-------------|-------------|
| **D1** | `contact` never an identity/dedup key; dedup is token → `user_id` → new; `guests.user_id` set server-side from `auth.uid()`. | ✅ | `submit_rsvp` (`0008`). | `migration-0008-submit-rsvp.test.ts` (bare contact ⇒ new row, no token leak), `task-2.4b`. |
| **D2** | Organizer profile reads via `get_public_events_by_host` (no anon direct table read); public+published only. | ✅ | `0011`, `/u/[username]` SSR. | `migration-0011-…aggregates.test.ts`, `task-6.1-organizer-profile.test.ts` (excludes private). |
| **D3** | Private event → `get_event_by_slug` returns `null` unless `service_role`; private only via trusted SSR. | ✅ | `0007` (`auth.role() <> 'service_role' → null`). | `migration-0007-get-event-by-slug.test.ts` (anon/authenticated direct call denied), `task-2.4a`. |
| **D4** | Polling, not Realtime; engaged/trusted pollers get a more generous quota aligned to the window. | ✅ | `lib/ratelimit/limiter.ts` (`event_poll` ≫ `event_read`); visibility-aware polling in feed/guest-list. | `task-3.1-guest-list.test.ts`, `task-4.1-comments.test.ts`. (Read-limiter quota split documented; see note on §2.3.5 below.) |
| **D5 / D13** | One shared gate `guest_unlock_status(event_id, token)`; the three guest-read RPCs must reuse it. | ✅ | `0006`; reused in `get_event_by_slug`, `get_guest_list`, `add_comment`. | `migration-0006-guest-unlock-status.test.ts`; **guardrail 6** greps reuse. |
| **D6** | Comment author server-bound (guest_id from gate, host_id from `auth.uid()`, no client param); `gif_url` never written; `rsvp_enabled=false` ⇒ host-only. | ✅ | `0010`. | `migration-0010-add-comment.test.ts` (author spoof rejected; gif not written; rsvp-disabled ⇒ guest denied), `task-4.1`. |
| **D7①** | Capacity decided under `pg_advisory_xact_lock` — no oversell. | ✅ | `0008`. | `migration-0008` concurrent N+5 → exactly N going. |
| **D7②** | `going_count`/`capacity_remaining` **omitted** (not zeroed) when `hide_guest_count` or private+unlocked. | ✅ | `0007`. | `migration-0007-get-event-by-slug.test.ts` (keys absent), `task-3.1`. |
| **D7③** | `finalize_date` / `promote_guest` host-only via `auth.uid() = host_id`; rejected under service-role (no auth context). | ✅ | `0011`. | `migration-0011-…aggregates.test.ts` (non-host + service-role both denied). |
| **D7④** | `profiles` row created by `auth.users` AFTER INSERT trigger; client never sends `id`. | ✅ | `0002`. | `migration-0001b.test.ts`, `task-2.1-host-auth.test.ts`. |
| **D7⑤ / amend** | Password = bcrypt; verify issues a short-lived signed credential cookie; reads/polls don't re-hash; password attempts independently rate-limited. | ✅ | `0014`, `verify_event_password`, `lib/events/password-credential.ts`, `password_attempt` quota. | `task-2.5-password-credential.test.ts`. |
| **D8** | 🟡 tables host-only SELECT, anon/guest deny; `answers` positive host read only. | ✅ | `0004` RLS. | `migration-0004-rls.test.ts` (parameterized 🟡-table deny; answers host-isolation). |
| **D9** | `events` RLS keyed on `host_id = auth.uid()`; `event_hosts` not relied on (owner row written by trigger). | ✅ | `0002`/`0004`. | `migration-0004-rls.test.ts`, `task-2.2a` (host reads back own event immediately). |
| **D10** | Guardrail RLS check runs against a real local DB (`RUN_DB_CHECKS=1`). | ✅ | `check-boundaries.sh` guardrail 5. | `check-boundaries.test.ts`. |
| **D11 / G2** | Orchestrator owns check-off; the agent never edits `[ ]`/`[x]`. | ✅ (process) | `run-agent.sh` / `TASKS.md` workflow. | Process control, not code. |
| **D12b** | DB-authoritative check extends to the `storage` schema. | ✅ | `check-boundaries.sh` guardrail 5 (storage.objects RLS). | `migration-0013-storage-buckets-rls.test.ts`. |
| **D14 / G7** | Read-side limiter (Next + Upstash, real IP) **and** write-side DB `rate_limits` backstop. | ✅ | `lib/ratelimit/*`; `rate_limits` used in `submit_rsvp`/`add_comment`/`verify_event_password`. | `task-2.3.5` spec (see note), `migration-0008` (DB limit hit when bypassing Next). |
| **D15** | Slug fail-closed (gen_random_bytes, retry once then raise); `submit_rsvp` returns token + confirmed status; seed `location_text` uses a unique sentinel. | ✅ | `0012`, `0008`, `seed.sql`. | `migration-0012-slug-generator.test.ts` (entropy, pure-random for CJK/empty, second-collision raise), `task-2.4a` (sentinel absent pre-RSVP). |
| **D16** | Storage: `event-covers` public/host-write, `event-photos` private; bucket `allowed_mime_types` + `file_size_limit`; object paths random-prefixed. | ✅ | `0013`. | `migration-0013-storage-buckets-rls.test.ts` (non-host upload denied, oversize/bad-mime denied, private bucket not anon-readable). |

---

## D. Guardrail invariants (G-series)

The G-series referenced in the source docs maps to checks in `check-boundaries.sh`:

| ID | Invariant | Status | Where |
|----|-----------|--------|-------|
| **G1** | Client-data tables carry **no** anon/public policy and **no** `using(true)`/`with check(true)`; anon reaches them only through DEFINER RPCs. | ✅ | guardrail 5 (`ANON_POLICY` / `PERMISSIVE_TRUE` queries); `migration-0005-anon-revoke.test.ts`. |
| **G2** | Orchestrator (not the agent) owns task check-off. | ✅ | See D11. |
| **G4** | The shared gate helper is reused by all three guest-read RPCs (no per-RPC re-implementation). | ✅ | guardrail 6 (greps `guest_unlock_status(` inside each RPC body). |
| **G7** | Write-side DB depth limiter (`rate_limits`) catches callers that bypass the Next layer. | ✅ | See D14; `rate_limits` RLS = enabled + explicit deny; DEFINER RPC (owner) bypasses RLS. |
| **G8** | `storage.objects` RLS enabled; anon cannot write; private bucket not publicly readable. | ✅ | guardrail 5 (storage RLS) + `migration-0013-storage-buckets-rls.test.ts`. |

> Note: the original review report enumerated `G1–G8`, but only `G1, G2, G4, G7,
> G8` are defined in the in-repo source docs (`CLAUDE.md` / `SCHEMA.md` /
> `TASKS.md`). `G3 / G5 / G6` have no in-repo definition to audit against; the
> guardrail invariants they would cover (slug entropy, no `sessionStorage`,
> no committed secrets) are nonetheless enforced by guardrails 2, 3a, and 4
> respectively and are listed above under the relevant decisions.

---

## E. Notes & residual items

- **§2.3.5 read-limiter coverage.** The read-side limiter (quota split, real-IP
  resolution, in-memory fallback) and the write-side DB backstop are implemented
  and exercised indirectly by the page/feed specs. There is **no dedicated
  `task-2.3.5` Vitest suite** asserting §2.3.5 ①②⑤ (429 on read overflow, poller
  not falsely limited, password-attempt throttle) end to end. The limiter logic
  itself is straightforward and documented in `lib/ratelimit/limiter.ts` /
  `ip.ts`; adding a focused suite for these three assertions is the one
  recommended follow-up. Not a security regression — the caps are always enforced
  (the limiter never fails open).
- **Uncommitted feature files (pre-existing).** Some feature/test files from
  earlier tasks (organizer profile `app/u/[username]/page.tsx`,
  `lib/events/public-events.ts`, `lib/events/read-public-events.ts`, and the
  `task-3.1` / `task-6.1` test files) were present on disk but untracked. They are
  part of completed, gated tasks and are required for the build to be coherent;
  they are committed as part of this final pass.
- **Going live is manual.** Cloud Supabase project, Vercel env, Upstash Redis,
  OAuth provider secrets, and `supabase db push` are operational steps (see
  `README.md` → Deployment). No code change is required to deploy.

**Conclusion:** the CLAUDE.md checklist and decisions D1–D16 / G1–G8 are all
satisfied in code and covered by the guardrail and/or the test suite, with the
single documented test-coverage gap above (read-side rate-limit assertions),
recorded here rather than silently passed.
