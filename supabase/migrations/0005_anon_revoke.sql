-- 0005_anon_revoke.sql — Task 1.4 [SECURITY]: anon read/write convergence (logical "0004").
--
-- Physical 0005_* (logical "0004" in TASKS.md). The Supabase CLI applies files in
-- numeric-prefix order, so physical numbering runs one ahead of the logical labels
-- (1.1a=0001 … 1.3=0004, 1.4=0005); this sorts right after 0004_rls_and_host_grants.sql.
--
-- GOAL (SCHEMA 安全模型 §1, D2/G1): the `anon` role can reach NO client-data table
-- directly. Every guest read/write flows through a SECURITY DEFINER RPC (1.5*),
-- whose body runs as the function owner and is therefore unaffected by anon's own
-- (now empty) table privileges. `authenticated` (the host) keeps its host-ownership
-- grants from 0004 — this task is anon-ONLY and never weakens the host path.
--
-- WHY THIS IS NOT A NO-OP — the TRUNCATE/TRIGGER/REFERENCES leak.
-- 0001-0004 issued zero DML grants to anon, so anon has no SELECT/INSERT/UPDATE/
-- DELETE (and those would be RLS-filtered anyway). BUT a freshly created public
-- table is NOT privilege-free for anon: the migration role (postgres) carries a
-- default-privilege entry — `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... TO
-- anon` — covering D(TRUNCATE) x(REFERENCES) t(TRIGGER) m(MAINTAIN). So every table
-- created in 0001-0003 SILENTLY granted anon TRUNCATE + TRIGGER + REFERENCES (0004's
-- header wrongly assumed "no privilege at all"). That matters because:
--   * TRUNCATE is NOT subject to RLS — anon holding TRUNCATE on `events` could
--     `truncate public.events cascade` and destroy every host's data, RLS or not.
--   * TRIGGER lets anon attach arbitrary triggers to the table.
--   * REFERENCES lets anon create foreign keys against it.
-- These are real, RLS-bypassing holes the anon-convergence invariant forbids.
--
-- THE FIX — two parts, both required:
--   (1) REVOKE every table privilege from anon on each existing client-data table
--       (closes the live TRUNCATE/TRIGGER/REFERENCES grant), and
--   (2) REVOKE the anon default privilege in schema public so FUTURE migration
--       tables created by this role do not re-grant TRUNCATE/TRIGGER/REFERENCES to
--       anon — the "从不 GRANT (仅 anon)" half. Without (2) the next CREATE TABLE
--       re-opens the hole; ALTER DEFAULT PRIVILEGES only affects later-created objects,
--       which is exactly why (1) is still needed for the tables already in place.
-- REVOKE of a privilege the grantee never held is a harmless no-op (a NOTICE, never
-- an error), so this runs cleanly whether or not a given grant is present.
--
-- SCOPE / non-goals: anon (+ the PUBLIC pseudo-role, the vector by which a future
-- blanket `grant ... to public` would reach anon) ONLY. `authenticated` is
-- deliberately untouched — it keeps the host-ownership SELECT/CRUD from 0004 so the
-- dashboard self-read (M1, incl. contact) and event editing keep working. (Its own
-- inherited TRUNCATE/TRIGGER/REFERENCES grants are a separate host-isolation matter,
-- not part of this anon-scoped task.) `contact` (D1) stays strictly host-visible:
-- after this, anon has no path to `guests` at all, and the guest-facing RPCs (1.5*)
-- project a desensitised column set that never includes it.

-- ── (1) Strip every table privilege from anon on all client-data tables ───────
-- `revoke all privileges` covers SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
-- TRIGGER (and MAINTAIN on PG16+). The list is the full set of public data tables —
-- the boundary check's CLIENT_TABLES plus profiles/event_hosts, equally host-only.
revoke all privileges on
    public.profiles,
    public.events,
    public.event_hosts,
    public.guests,
    public.rsvps,
    public.comments,
    public.comment_reactions,
    public.event_photos,
    public.date_options,
    public.date_votes,
    public.questions,
    public.answers,
    public.scheduled_reminders,
    public.broadcasts,
    public.rate_limits
  from anon;

-- Belt-and-suspenders: the PUBLIC pseudo-role holds nothing here today, but a future
-- careless `grant ... to public` would reach anon through it. Strip it too. This does
-- NOT touch the explicit `authenticated` grants — privileges are additive per
-- grantee, so revoking PUBLIC leaves every role-specific grant intact.
revoke all privileges on
    public.profiles,
    public.events,
    public.event_hosts,
    public.guests,
    public.rsvps,
    public.comments,
    public.comment_reactions,
    public.event_photos,
    public.date_options,
    public.date_votes,
    public.questions,
    public.answers,
    public.scheduled_reminders,
    public.broadcasts,
    public.rate_limits
  from public;

-- ── (2) Stop FUTURE tables from re-granting anything to anon ───────────────────
-- Rewrites the migration role's (postgres) default privileges in schema public so
-- the next CREATE TABLE grants anon nothing — the "从不 GRANT" half of the task.
-- `for role postgres` pins it to the role that owns the offending default entry
-- (the source of the inherited anon=Dxtm grants above), regardless of which
-- superuser applies the migration.
alter default privileges for role postgres in schema public
  revoke all on tables from anon;
