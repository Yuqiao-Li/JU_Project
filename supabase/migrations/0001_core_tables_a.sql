-- 0001_core_tables_a.sql — Task 1.1a: core tables A (profiles + events).
--
-- Creates the two anchor tables of the data model:
--   * profiles — host account mirror of auth.users (+ unique username for the
--     Organizer Profile route), SCHEMA §1.
--   * events   — the core entity, with EVERY SCHEMA §2 column, including the 🟡
--     placeholder columns (lat/lng/anonymize_guest_list/allow_photo_upload/
--     guest_approval_enabled) and view_password_hash.
--
-- Deliberately NOT in this migration (later tasks, additive):
--   * RLS + policies (task 1.3) — tables ship with RLS off here; with Supabase
--     auto-expose off, no role reaches them via PostgREST until grants land.
--   * No GRANTs to anon/authenticated/service_role — exposure is deferred to the
--     RLS/grant tasks (1.3/1.4) so the anon-revocation design is not pre-empted.
--   * event_hosts/guests/rsvps + updated_at/profile-creation/owner-row triggers
--     (task 1.1b); the full slug generator (slugify + base62, task 1.6).

create extension if not exists pgcrypto with schema extensions;

-- ── profiles (SCHEMA §1) ─────────────────────────────────────────────────────
-- id = auth.users.id; profile rows are created by an auth.users trigger in 1.1b
-- (client never sends id). RLS keyed on id = auth.uid() comes in 1.3.
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url   text,
  username     text,
  created_at   timestamptz not null default now()
);

-- Username uniqueness is enforced by the DB (the settings UI check is advisory
-- only, SCHEMA §1). Nullable column -> multiple NULL usernames are allowed.
create unique index profiles_username_key on public.profiles (username);

-- ── events (SCHEMA §2) ───────────────────────────────────────────────────────
create table public.events (
  id                     uuid primary key default gen_random_uuid(),
  host_id                uuid not null references public.profiles (id) on delete cascade,
  -- The full human-readable-prefix + 10-char base62 generator is task 1.6. This
  -- column default is a fail-closed crypto-strong fallback so the column is never
  -- null even if a caller forgets to set it (uses gen_random_bytes from pgcrypto
  -- — never a weak/non-cryptographic source). The unique constraint guarantees
  -- collision-safety. Schema-qualified so it resolves under any role's search_path.
  slug                   text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  title                  text not null,
  description            text,
  cover_image_url        text,
  theme                  jsonb not null default '{}'::jsonb,
  effect                 text,
  starts_at              timestamptz,
  ends_at                timestamptz,
  date_tbd               boolean not null default false,
  location_text          text,                                   -- full address — second class (post-RSVP)
  location_url           text,                                   -- second class
  location_city          text,                                   -- city-level — first class (pre-RSVP)
  lat                    double precision,                       -- 🟡 reserved, always null in MVP
  lng                    double precision,                       -- 🟡 reserved, always null in MVP
  visibility             text not null default 'public'
                           check (visibility in ('public', 'private')),
  view_password_hash     text,                                   -- bcrypt (crypt/gen_salt('bf',12)), set/cleared server-side
  capacity               integer,
  allow_plus_ones        boolean not null default false,
  max_plus_ones          integer not null default 1,
  rsvp_enabled           boolean not null default true,
  hide_guest_list        boolean not null default false,
  hide_guest_count       boolean not null default false,
  hide_feed_timestamps   boolean not null default false,
  anonymize_guest_list   boolean not null default false,         -- 🟡 render logic deferred
  allow_photo_upload     boolean not null default false,         -- 🟡 album toggle, event_photos deferred
  guest_approval_enabled boolean not null default false,         -- 🟡 approval toggle, rsvps.approval_status deferred
  chip_in_url            text,                                   -- AA collection link (display only)
  chip_in_note           text,
  status                 text not null default 'draft'
                           check (status in ('draft', 'published', 'cancelled')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index events_host_id_idx on public.events (host_id);
create index events_status_idx on public.events (status);

-- ── Row Level Security (SCHEMA RLS 总则 §1–2 / D9) ────────────────────────────
-- RLS is enabled the moment a table exists — never left off (CLAUDE.md: 绝不削弱
-- RLS). The remaining tables (guests/rsvps/comments/…) get RLS in their own
-- migrations (1.1b/1.2) + the consolidated [SECURITY] pass in 1.3. No GRANTs are
-- issued here, so anon/authenticated still cannot reach these tables via
-- PostgREST (auto-expose off); host/guest data flows through SECURITY DEFINER
-- RPCs and the host-ownership grants land with task 1.3/1.4.

alter table public.profiles enable row level security;
alter table public.events   enable row level security;

-- profiles: a logged-in user manages ONLY their own row (id = auth.uid()).
-- Public host fields (display_name) are exposed through DEFINER RPCs, not direct
-- reads. `to authenticated` — anon has no auth.uid() and no business here.
create policy profiles_self_all on public.profiles
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- events: the RLS authority key is host_id = auth.uid() (D9). A host reads/writes
-- ONLY their own events (dashboard). Public reads of an event go through
-- get_event_by_slug (DEFINER); anon has NO events policy. All policies are
-- `to authenticated` (I1) so they never default to the public/anon role.
create policy events_select_own on public.events
  for select to authenticated
  using (host_id = auth.uid());

create policy events_insert_own on public.events
  for insert to authenticated
  with check (host_id = auth.uid());

create policy events_update_own on public.events
  for update to authenticated
  using (host_id = auth.uid())
  with check (host_id = auth.uid());

create policy events_delete_own on public.events
  for delete to authenticated
  using (host_id = auth.uid());
