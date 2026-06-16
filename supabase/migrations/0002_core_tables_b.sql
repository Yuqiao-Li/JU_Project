-- 0002_core_tables_b.sql — Task 1.1b: core tables B (event_hosts + guests +
-- rsvps) + the triggers that keep the data model consistent.
--
-- Named 0002_* (not 0001b_*) on purpose: the Supabase CLI ONLY applies files
-- whose version prefix is purely numeric ("file name must match pattern
-- <timestamp>_name.sql"); a "0001b_*" file is silently SKIPPED and never runs.
-- 0002 sorts immediately after 0001_core_tables_a.sql.
--
-- Creates:
--   * event_hosts (SCHEMA §3) — co-host link table (🟡). MVP only ever holds the
--     creator's owner row, written by an events AFTER INSERT trigger. RLS does
--     NOT depend on this table (D9); events.host_id stays the authority key.
--   * guests (SCHEMA §4) — accountless guests, identified by guest_token; the
--     optional user_id link (D1) is set server-side by submit_rsvp, never by a
--     client, and lets a logged-in guest be recognised across devices.
--   * rsvps (SCHEMA §5) — going/maybe/not_going/waitlisted, with the 🟡
--     approval_status column built but always 'approved' in MVP.
--   * triggers: updated_at bump (events + rsvps), events→event_hosts owner row,
--     auth.users→profiles row (D7④).
--
-- RLS posture mirrors 1.1a: RLS is enabled the moment a table exists (绝不削弱
-- RLS) with `to authenticated` host-ownership policies (I1 — never default to the
-- public/anon role). NO GRANTs are issued here, so anon/authenticated still can't
-- reach these tables via PostgREST (auto-expose off); the host-ownership GRANTs
-- and the anon-revocation pass land with tasks 1.3/1.4. Guest reads/writes always
-- flow through the SECURITY DEFINER RPCs (later tasks).

-- ── event_hosts (SCHEMA §3) ──────────────────────────────────────────────────
create table public.event_hosts (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner', 'cohost')),
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

-- (event_id, user_id) is the leading-column index for event-scoped lookups; a
-- separate user_id index powers the "events I host" dashboard query.
create index event_hosts_user_id_idx on public.event_hosts (user_id);

-- ── guests (SCHEMA §4) ───────────────────────────────────────────────────────
create table public.guests (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events (id) on delete cascade,
  -- guest_token is the guest credential (localStorage + RPC return value, NEVER
  -- in a URL). gen_random_uuid() is crypto-strong; unique guarantees no clash.
  guest_token  uuid not null unique default gen_random_uuid(),
  -- D1: optional link to an account, written server-side from auth.uid() by
  -- submit_rsvp (client never sends it). on delete set null — losing the account
  -- must NOT delete the guest's RSVP history. NULLs are fine (anonymous guests).
  user_id      uuid references public.profiles (id) on delete set null,
  display_name text not null,
  -- contact is host-visible metadata only; never an identity/auth key (D1).
  contact      text,
  created_at   timestamptz not null default now()
);

create index guests_event_id_idx on public.guests (event_id);
create index guests_user_id_idx on public.guests (user_id) where user_id is not null;

-- ── rsvps (SCHEMA §5) ────────────────────────────────────────────────────────
create table public.rsvps (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events (id) on delete cascade,
  guest_id        uuid not null references public.guests (id) on delete cascade,
  status          text not null check (status in ('going', 'maybe', 'not_going', 'waitlisted')),
  plus_ones       integer not null default 0 check (plus_ones >= 0),
  -- 🟡 approval_status: column built, always 'approved' in MVP (guest_approval
  -- toggle deferred). Capacity/waitlist logic lives in submit_rsvp (D7①).
  approval_status text not null default 'approved'
                    check (approval_status in ('pending', 'approved', 'rejected')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (event_id, guest_id)
);

create index rsvps_event_id_idx on public.rsvps (event_id);
create index rsvps_guest_id_idx on public.rsvps (guest_id);

-- ── Triggers ─────────────────────────────────────────────────────────────────

-- updated_at maintenance: a BEFORE UPDATE trigger forces updated_at = now() so a
-- client can never spoof it. Reused by events and rsvps (both carry updated_at).
-- Not SECURITY DEFINER — it only touches NEW.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger events_set_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

create trigger rsvps_set_updated_at
  before update on public.rsvps
  for each row execute function public.set_updated_at();

-- events AFTER INSERT -> write the creator's owner row into event_hosts (SCHEMA
-- §3). SECURITY DEFINER (runs as the table owner) so it bypasses event_hosts RLS
-- — clients have no INSERT policy/grant there; the owner row is trusted data.
-- search_path is pinned empty (everything schema-qualified) to harden the
-- definer function against search_path hijacking.
create or replace function public.handle_new_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.event_hosts (event_id, user_id, role)
  values (new.id, new.host_id, 'owner')
  on conflict (event_id, user_id) do nothing;
  return new;
end;
$$;

create trigger on_event_created
  after insert on public.events
  for each row execute function public.handle_new_event();

-- auth.users AFTER INSERT -> create the host's profiles row (D7④). The client
-- NEVER sends profiles.id; signup (magic link / Google) creates it here. SECURITY
-- DEFINER so it can write public.profiles (auth admin role can't) and bypass
-- profiles RLS. on conflict do nothing keeps it idempotent.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Row Level Security (SCHEMA RLS 总则 §3 / D9) ──────────────────────────────
-- RLS on from creation. Host-ownership SELECT policies, all `to authenticated`
-- (I1). No GRANTs here, so nothing is reachable via PostgREST yet — these are the
-- predicate layer; the exposing GRANTs + anon-revocation come in 1.3/1.4. Guest
-- access is exclusively through SECURITY DEFINER RPCs.
alter table public.event_hosts enable row level security;
alter table public.guests      enable row level security;
alter table public.rsvps       enable row level security;

-- event_hosts: a user sees the host rows where they are the host/co-host. Keyed
-- on user_id = auth.uid() (NOT a reverse join to events) to avoid RLS recursion
-- when co-host support arrives (SCHEMA §3).
create policy event_hosts_select_own on public.event_hosts
  for select to authenticated
  using (user_id = auth.uid());

-- guests/rsvps: the owning host (events.host_id = auth.uid()) may read their own
-- event's rows (dashboard / full guest list incl. contact, once GRANTed in 1.3).
-- Anon has NO policy — guest reads go through DEFINER RPCs only (G1). Writes are
-- DEFINER-only too, so no INSERT/UPDATE/DELETE policy is granted to clients.
create policy guests_select_by_host on public.guests
  for select to authenticated
  using (
    exists (
      select 1 from public.events e
      where e.id = guests.event_id and e.host_id = auth.uid()
    )
  );

create policy rsvps_select_by_host on public.rsvps
  for select to authenticated
  using (
    exists (
      select 1 from public.events e
      where e.id = rsvps.event_id and e.host_id = auth.uid()
    )
  );
