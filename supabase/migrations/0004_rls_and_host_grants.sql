-- 0004_rls_and_host_grants.sql — Task 1.3 [SECURITY]: enable RLS + policies.
--
-- Named 0004_* (TASKS.md labels this task "(0003)" logically): the Supabase CLI
-- only applies files with a purely-numeric version prefix, so the logical
-- numbering is offset by one from the physical files (1.1a=0001, 1.1b=0002,
-- 1.2=0003, 1.3=0004 — see the 0002/0003 headers for the same renaming note).
--
-- WHAT THIS MIGRATION DOES
-- Every public table already ships with RLS ENABLED + non-permissive,
-- host-ownership / deny policies — these were front-loaded into 0001-0003 on the
-- principle "RLS on from creation" (CLAUDE.md: 绝不削弱 RLS). Concretely, already
-- in place and unchanged here:
--   * profiles            — using/with check (id = auth.uid())            [SCHEMA §1]
--   * events (D9)         — host_id = auth.uid() for SELECT/INSERT/UPDATE/DELETE
--   * event_hosts         — user_id = auth.uid() SELECT (no reverse join, D9)
--   * guests/rsvps/comments/comment_reactions/event_photos/date_options/
--     date_votes/questions/answers/scheduled_reminders/broadcasts
--                          — host-ownership SELECT (walk up to events.host_id),
--                            all `to authenticated` (I1 — never default to public)
--   * rate_limits         — explicit deny-all `for all to authenticated
--                            using(false) with check(false)` (M3)
-- So the policy layer (the predicates) is complete. What this [SECURITY] pass
-- adds is the piece that makes those host-ownership policies actually REACHABLE.
--
-- WHY GRANTS ARE THE REAL WORK OF 1.3
-- This project runs with auto_expose_new_tables OFF — the new Supabase cloud
-- default (see supabase/config.toml [api]; the field is unset). Under that
-- default a freshly created public table gets NO SELECT/INSERT/UPDATE/DELETE
-- privilege for the Data API roles (anon/authenticated); the role cannot reach
-- the table at all until an explicit GRANT (a missing grant => "permission denied
-- for table", NOT an empty result). As shipped by 0001-0003, `authenticated`
-- therefore has zero data privileges on these tables, so the host-ownership RLS
-- policies are inert: a logged-in host cannot read their own event's guests
-- (TEST-SPEC §1.3 M1 would fail) because the GRANT is missing, not the policy.
-- This migration issues exactly those grants, each scoped to what the table's
-- existing policy supports. RLS still row-filters everything to
-- `host_id = auth.uid()`, so a GRANT never widens visibility beyond the owner:
-- a non-owner authenticated user (e.g. a logged-in guest who only attends the
-- event) sees ZERO rows, and `contact` stays strictly host-visible.
--
-- WHAT IS DELIBERATELY NOT GRANTED
--   * anon — gets NOTHING here and has no policy, so anon stays fully denied on
--     every client-data table (events/guests/rsvps/comments/date_votes/answers/…);
--     all guest reads/writes flow only through SECURITY DEFINER RPCs (1.5*). The
--     explicit belt-and-suspenders REVOKE-from-anon is task 1.4 (next migration).
--   * rate_limits — authenticated is explicitly denied (deny-all policy, M3) and
--     receives no grant; only the SECURITY DEFINER write RPCs touch it, as the
--     table owner (bypassing RLS). Granting it would defeat the depth limiter.
--   * Direct client DML on the child / 🟡 tables — every guest-side AND host-side
--     write goes through a DEFINER RPC (submit_rsvp / add_comment / promote_guest
--     / finalize_date / vote_dates), never client DML. Hence SELECT-only grants
--     below for everything except `events` (the one entity a host edits directly).
--
-- STORAGE (D16): storage.objects already has RLS ENABLED (Supabase default; the
-- `postgres` migration role is NOT its owner — supabase_storage_admin is — and
-- cannot toggle RLS on it). The deny-all baseline (RLS on + no policy = every
-- non-owner caller refused) is the correct, safe state for this task and already
-- satisfies every TEST-SPEC §1.3 storage assertion (all are DENY assertions:
-- non-host upload rejected, anon read of the private album rejected). The actual
-- bucket creation + the host-write / public-read-cover / private-photo policies
-- are built in task 1.7, co-located with the buckets they reference — exactly as
-- check-boundaries 护栏 5/8 documents ("buckets/策略在 1.7 才建;故断言 RLS 启用
-- 而非必须已有策略"). Nothing to add for storage here.

-- ── Host-ownership data grants to `authenticated` (auto-expose is OFF) ─────────

-- events: the only entity a host writes directly (dashboard create / edit /
-- cancel). Full CRUD; RLS (events_*_own, host_id = auth.uid()) scopes every row
-- and every WITH CHECK to the owner, so a host can never touch another's event.
grant select, insert, update, delete on public.events to authenticated;

-- profiles: a host reads + edits ONLY their own row (RLS: id = auth.uid()). The
-- row is created by the auth.users AFTER INSERT trigger (D7④, handle_new_user),
-- so the client never INSERTs and never DELETEs (that is account deletion) —
-- SELECT + UPDATE (display_name / username / avatar) is the whole client surface.
grant select, update on public.profiles to authenticated;

-- Host-readable tables: SELECT only. A host reads their own event's full data for
-- the dashboard (incl. the complete guest list with `contact`); every write is
-- RPC-mediated. RLS walks each row up to events.host_id = auth.uid(), so a
-- non-owner sees nothing and `contact` is never exposed beyond the owning host.
grant select on public.event_hosts         to authenticated;
grant select on public.guests              to authenticated;
grant select on public.rsvps               to authenticated;
grant select on public.comments            to authenticated;
grant select on public.comment_reactions   to authenticated;
grant select on public.event_photos        to authenticated;
grant select on public.date_options        to authenticated;
grant select on public.date_votes          to authenticated;
grant select on public.questions           to authenticated;
grant select on public.answers             to authenticated;   -- host-only read (D8)
grant select on public.scheduled_reminders to authenticated;
grant select on public.broadcasts          to authenticated;

-- (rate_limits: intentionally NO grant — deny-all to authenticated, DEFINER-only.)
-- (anon: intentionally NO grant on any table — stays fully denied; 1.4 REVOKEs
--  explicitly for defense-in-depth.)
