-- 0003_extension_tables.sql — Task 1.2: extension tables (logical "0002").
--
-- Named 0003_* (not 0002b_*): the Supabase CLI ONLY applies files whose version
-- prefix is purely numeric — a "0002b_*" file is silently SKIPPED (same reason
-- 1.1b's logical "0001b" shipped as 0002_core_tables_b.sql). 0003 sorts right
-- after 0002_core_tables_b.sql.
--
-- Creates the remaining data model so the schema is extension-ready from day one
-- (CLAUDE.md: 数据模型一次建对,功能可延后). All but comments/date_options/
-- date_votes/rate_limits are 🟡 — TABLE ONLY, NO UI this task (boundary check 护栏
-- 1 blacklists their frontend):
--   * comments (SCHEMA §6, 🟢) — Activity Feed, MVP text-only. CHECK exactly one
--     of guest_id/host_id is non-null; gif_url column kept but add_comment never
--     writes it (D6 — GIF XSS surface removed for MVP).
--   * comment_reactions (§7, 🟡) / event_photos (§8, 🟡).
--   * date_options (§9, 🟢) / date_votes (§10, 🟢) — date poll.
--   * questions (§11, 🟡) — type incl. 'social' / answers (§12, 🟡, host-only read).
--   * scheduled_reminders (§13, 🟡) / broadcasts (§14, 🟡).
--   * rate_limits (§15, 🟢, D14/G7) — write-side DB depth limiting; reached ONLY
--     by SECURITY DEFINER RPCs as owner (bypassing RLS). RLS on + an explicit
--     deny policy (M3) so every non-owner caller is refused yet the table still
--     satisfies "every table has a non-permissive policy".
--
-- RLS posture mirrors 1.1a/1.1b: RLS enabled the moment a table exists (绝不削弱
-- RLS) with host-ownership SELECT policies, all `to authenticated` (I1 — never
-- default to the public/anon role; the boundary check flags anon/public policies
-- on client-data tables). NO client GRANTs are issued here, so anon/authenticated
-- still can't reach these via PostgREST (auto-expose off); the exposing GRANTs +
-- the anon-revocation/storage/profiles passes land with the [SECURITY] tasks
-- 1.3/1.4. Guest reads/writes flow exclusively through the DEFINER RPCs (1.5*).

-- ── comments (SCHEMA §6, 🟢) ──────────────────────────────────────────────────
create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  -- guest_id: taken from the verified token server-side (D6), never client-sent.
  guest_id   uuid references public.guests (id) on delete cascade,
  -- host_id: taken from auth.uid() server-side (D6).
  host_id    uuid references public.profiles (id) on delete cascade,
  body       text not null,
  -- 🟡 gif_url: column kept for the future, but add_comment never writes it (D6).
  -- Re-enabling needs https + a domain allowlist before it ships.
  gif_url    text,
  created_at timestamptz not null default now(),
  -- exactly one author: a comment is EITHER a guest's OR the host's (SCHEMA §6).
  constraint comments_one_author check (num_nonnulls(guest_id, host_id) = 1)
);

create index comments_event_id_created_at_idx on public.comments (event_id, created_at);

-- ── comment_reactions (SCHEMA §7, 🟡) ─────────────────────────────────────────
create table public.comment_reactions (
  id         uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments (id) on delete cascade,
  guest_id   uuid not null references public.guests (id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  unique (comment_id, guest_id, emoji)
);

create index comment_reactions_comment_id_idx on public.comment_reactions (comment_id);

-- ── event_photos (SCHEMA §8, 🟡) ──────────────────────────────────────────────
-- Album reuses the private `event-photos` bucket (D16); gated by
-- events.allow_photo_upload. Uploader link is nullable (set null on delete keeps
-- the photo if the guest/host row is removed).
create table public.event_photos (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  guest_id   uuid references public.guests (id) on delete set null,
  host_id    uuid references public.profiles (id) on delete set null,
  image_url  text not null,
  created_at timestamptz not null default now()
);

create index event_photos_event_id_idx on public.event_photos (event_id);

-- ── date_options (SCHEMA §9, 🟢) ──────────────────────────────────────────────
create table public.date_options (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz,
  created_at timestamptz not null default now()
);

create index date_options_event_id_idx on public.date_options (event_id);

-- ── date_votes (SCHEMA §10, 🟢) ───────────────────────────────────────────────
-- Multi-select upsert in vote_dates; finalize_date keeps these rows (votes are
-- never deleted on finalize, SCHEMA §9–10).
create table public.date_votes (
  id             uuid primary key default gen_random_uuid(),
  date_option_id uuid not null references public.date_options (id) on delete cascade,
  guest_id       uuid not null references public.guests (id) on delete cascade,
  created_at     timestamptz not null default now(),
  unique (date_option_id, guest_id)
);

create index date_votes_date_option_id_idx on public.date_votes (date_option_id);
create index date_votes_guest_id_idx on public.date_votes (guest_id);

-- ── questions (SCHEMA §11, 🟡) ────────────────────────────────────────────────
create table public.questions (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  prompt     text not null,
  -- 'social' included now so the questionnaire is extension-ready (SCHEMA §11).
  type       text not null check (type in ('text', 'single', 'multi', 'social')),
  options    jsonb,
  required   boolean not null default false,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

create index questions_event_id_position_idx on public.questions (event_id, position);

-- ── answers (SCHEMA §12, 🟡) ──────────────────────────────────────────────────
-- host-only read (D8): the host-ownership SELECT policy below; anon/guest never
-- reachable (asserted in TEST-SPEC §1.3). CSV export comes later.
create table public.answers (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  guest_id    uuid not null references public.guests (id) on delete cascade,
  value       jsonb not null,
  created_at  timestamptz not null default now(),
  unique (question_id, guest_id)
);

create index answers_question_id_idx on public.answers (question_id);
create index answers_guest_id_idx on public.answers (guest_id);

-- ── scheduled_reminders (SCHEMA §13, 🟡) ──────────────────────────────────────
-- guest_id null = whole-event reminder. Scheduling/delivery deferred.
create table public.scheduled_reminders (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  guest_id   uuid references public.guests (id) on delete cascade,
  remind_at  timestamptz not null,
  channel    text not null check (channel in ('email', 'sms')),
  status     text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);

create index scheduled_reminders_event_id_idx on public.scheduled_reminders (event_id);

-- ── broadcasts (SCHEMA §14, 🟡) ───────────────────────────────────────────────
create table public.broadcasts (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  body       text not null,
  channel    text not null check (channel in ('email', 'sms')),
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);

create index broadcasts_event_id_idx on public.broadcasts (event_id);

-- ── rate_limits (SCHEMA §15, 🟢, D14/G7) ──────────────────────────────────────
-- Write-side DB depth limiting for submit_rsvp / add_comment /
-- verify_event_password — catches callers that bypass Next/Upstash and hit the
-- write RPCs directly. unique(bucket_key, window_start) is the atomic
-- upsert-and-increment key.
create table public.rate_limits (
  id           uuid primary key default gen_random_uuid(),
  bucket_key   text not null,           -- e.g. submit:{event_id}:{ip_or_fingerprint}
  window_start timestamptz not null,    -- current window start
  count        integer not null default 0,
  unique (bucket_key, window_start)
);

-- ── Row Level Security (SCHEMA RLS 总则 §3–5 / D8 / D9 / M3) ───────────────────
-- RLS on from creation. Host-ownership SELECT policies are keyed on the owning
-- event (events.host_id = auth.uid()); 🟡 tables are host-SELECT-only with
-- anon/guest deny. No GRANTs here — these are the predicate layer; the exposing
-- GRANTs + anon-revocation pass land in 1.3/1.4.
alter table public.comments            enable row level security;
alter table public.comment_reactions   enable row level security;
alter table public.event_photos        enable row level security;
alter table public.date_options        enable row level security;
alter table public.date_votes          enable row level security;
alter table public.questions           enable row level security;
alter table public.answers             enable row level security;
alter table public.scheduled_reminders enable row level security;
alter table public.broadcasts          enable row level security;
alter table public.rate_limits         enable row level security;

-- Tables that reference events directly: scope by events.host_id = auth.uid().
create policy comments_select_by_host on public.comments
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = comments.event_id and e.host_id = auth.uid()));

create policy event_photos_select_by_host on public.event_photos
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_photos.event_id and e.host_id = auth.uid()));

create policy date_options_select_by_host on public.date_options
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = date_options.event_id and e.host_id = auth.uid()));

create policy questions_select_by_host on public.questions
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = questions.event_id and e.host_id = auth.uid()));

create policy scheduled_reminders_select_by_host on public.scheduled_reminders
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = scheduled_reminders.event_id and e.host_id = auth.uid()));

create policy broadcasts_select_by_host on public.broadcasts
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = broadcasts.event_id and e.host_id = auth.uid()));

-- Child tables one hop from events: walk the parent up to events.host_id. No RLS
-- recursion (comment_reactions->comments->events, etc. form a DAG).
create policy comment_reactions_select_by_host on public.comment_reactions
  for select to authenticated
  using (exists (
    select 1 from public.comments c join public.events e on e.id = c.event_id
    where c.id = comment_reactions.comment_id and e.host_id = auth.uid()
  ));

create policy date_votes_select_by_host on public.date_votes
  for select to authenticated
  using (exists (
    select 1 from public.date_options d join public.events e on e.id = d.event_id
    where d.id = date_votes.date_option_id and e.host_id = auth.uid()
  ));

-- answers: host-only read (D8). Same ownership walk through questions->events.
create policy answers_select_by_host on public.answers
  for select to authenticated
  using (exists (
    select 1 from public.questions q join public.events e on e.id = q.event_id
    where q.id = answers.question_id and e.host_id = auth.uid()
  ));

-- rate_limits: explicit deny-all to authenticated (M3). anon gets NO policy. The
-- DEFINER RPCs touch this table as the table owner, bypassing RLS entirely; every
-- other caller is refused. Satisfies "every table has a non-permissive policy"
-- without exposing the counters to any client.
create policy rate_limits_deny_all on public.rate_limits
  for all to authenticated
  using (false)
  with check (false);
