-- seed.sql — demo data for local dev, applied by `supabase db reset`
-- (config.toml [db.seed].sql_paths = ["./seed.sql"]). Task 1.8.
--
-- Lays down a small, realistic slice of the data model so the app has something
-- to render locally and the later frontend tasks have stable fixtures:
--   * 1 host (auth.users row → handle_new_user trigger creates the profiles row;
--     we then set its username for the Organizer Profile route).
--   * 1 PUBLIC + 1 PRIVATE event, both owned by that host. The public event's
--     full street address (location_text, second tier) is a unique SENTINEL
--     string so a Phase 2.4 SSR leak test has an unambiguous value to grep
--     (TEST-SPEC §2.4 / D15).
--   * several guests + rsvps spanning every status (going/maybe/not_going/
--     waitlisted) — incl. a full-capacity → waitlist case.
--   * a few comments (host-authored + guest-authored).
--   * one date poll (date_options + date_votes), on the date-TBD private event.
--
-- Everything is namespaced `demo-`/`demo_` with fixed UUIDs so it never collides
-- with the prefixed fixtures the test suites create/tear down, and so re-running
-- the seed is idempotent (ON CONFLICT DO NOTHING). This runs as the postgres
-- superuser during `db reset`, so it may write auth.users + bypass RLS directly;
-- the triggers (profiles creation, event_hosts owner row, updated_at) all fire.

-- ── 1. Demo host (auth.users → profiles via handle_new_user trigger) ──────────
-- The token columns (confirmation_token/recovery_token/email_change_token_new/
-- email_change) have NO column default, so a bare INSERT leaves them NULL — but
-- GoTrue's admin API scans them into non-nullable Go strings and 500s on NULL
-- ("converting NULL to string is unsupported"), which would break the test
-- harness's host-session minting. Set them to '' (what the GoTrue API itself
-- writes) so auth.admin.listUsers stays healthy.
insert into auth.users (
  id, instance_id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values (
  'd0d00000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'demo-host@partiful.local',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Demo Host"}'::jsonb,
  now(), now(), now(),
  '', '', '', ''
)
on conflict (id) do nothing;

-- The trigger created the profiles row from full_name; pin display_name + the
-- (DB-unique) username for the /u/[username] organizer page.
update public.profiles
   set display_name = 'Demo Host',
       username     = 'demo_host'
 where id = 'd0d00000-0000-4000-8000-000000000001';

-- ── 2. Events (PUBLIC published + PRIVATE date-TBD), owned by the demo host ────
-- AFTER INSERT trigger handle_new_event writes the event_hosts owner row for each.
insert into public.events (
  id, host_id, slug, title, description,
  visibility, status,
  starts_at, ends_at, date_tbd,
  location_text, location_url, location_city,
  capacity, allow_plus_ones, max_plus_ones,
  hide_guest_list, hide_guest_count,
  chip_in_url, chip_in_note,
  theme, effect, cover_image_url
)
values
  -- PUBLIC, published, concrete date. location_text is the SENTINEL (2nd tier);
  -- location_city is the 1st-tier facade. capacity 4 so the seed can demo a
  -- full-house → waitlist (Alice+1 and Bob take 3 going seats; Carol is 'maybe'
  -- and takes no seat; Dave is waitlisted).
  (
    'e0e00000-0000-4000-8000-0000000000a1',
    'd0d00000-0000-4000-8000-000000000001',
    'demo-summer-rooftop-bash',
    'Summer Rooftop Bash',
    'Sunset drinks, a tiny DJ set, and a skyline view. Bring a friend.',
    'public', 'published',
    now() + interval '21 days', now() + interval '21 days' + interval '5 hours', false,
    'SEED-LOC-SENTINEL-7Kq9mZ2x-do-not-leak',  -- full address, second tier (sentinel)
    'https://maps.example.com/demo-rooftop',
    'Brooklyn, NY',                            -- city-level, first tier
    4, true, 2,
    false, false,
    'https://venmo.com/u/demo-host', 'Optional $10 toward drinks — totally fine to skip!',
    '{"primary":"#ff5d8f","mode":"dark"}'::jsonb, 'confetti',
    'https://images.example.com/demo/rooftop-cover.jpg'
  ),
  -- PRIVATE, published, date TBD (drives the date poll below). Also carries a
  -- sentinel-tagged full address to prove private detail never leaks pre-unlock.
  (
    'e0e00000-0000-4000-8000-0000000000a2',
    'd0d00000-0000-4000-8000-000000000001',
    'demo-members-only-tasting',
    'Members-Only Natural Wine Tasting',
    'Six pours, six stories. Date is up to the group — vote below.',
    'private', 'published',
    null, null, true,
    'SEED-LOC-SENTINEL-private-3Qx8w1Zk-do-not-leak',
    null,
    'Brooklyn, NY',
    12, false, 1,
    false, false,
    null, null,
    '{"primary":"#7c5cff","mode":"dark"}'::jsonb, null,
    null
  )
on conflict (id) do nothing;

-- ── 3. Guests (guest_token is the credential — fixed here for stable fixtures) ─
-- contact is host-visible metadata only (D1); some guests omit it.
insert into public.guests (id, event_id, guest_token, display_name, contact)
values
  -- Public event guests.
  ('c0c00000-0000-4000-8000-000000000001', 'e0e00000-0000-4000-8000-0000000000a1',
   'a0a00000-0000-4000-8000-000000000001', 'Alice Rivera', 'alice@example.com'),
  ('c0c00000-0000-4000-8000-000000000002', 'e0e00000-0000-4000-8000-0000000000a1',
   'a0a00000-0000-4000-8000-000000000002', 'Bob Chen', '+1-555-0102'),
  ('c0c00000-0000-4000-8000-000000000003', 'e0e00000-0000-4000-8000-0000000000a1',
   'a0a00000-0000-4000-8000-000000000003', 'Carol Nguyen', null),
  ('c0c00000-0000-4000-8000-000000000004', 'e0e00000-0000-4000-8000-0000000000a1',
   'a0a00000-0000-4000-8000-000000000004', 'Dave Okafor', 'dave@example.com'),
  -- Private event guests (they vote on the date poll).
  ('c0c00000-0000-4000-8000-000000000005', 'e0e00000-0000-4000-8000-0000000000a2',
   'a0a00000-0000-4000-8000-000000000005', 'Erin Walsh', 'erin@example.com'),
  ('c0c00000-0000-4000-8000-000000000006', 'e0e00000-0000-4000-8000-0000000000a2',
   'a0a00000-0000-4000-8000-000000000006', 'Frank Mori', null)
on conflict (id) do nothing;

-- ── 4. RSVPs — every status represented (going/maybe/not_going/waitlisted) ─────
-- Public event capacity=4. Going seats taken: Alice(1+1=2) + Bob(1) = 3. Carol is
-- 'maybe' (no seat). Dave is 'waitlisted' to demo a full/over-capacity case.
insert into public.rsvps (id, event_id, guest_id, status, plus_ones)
values
  ('b0b00000-0000-4000-8000-000000000001', 'e0e00000-0000-4000-8000-0000000000a1',
   'c0c00000-0000-4000-8000-000000000001', 'going', 1),
  ('b0b00000-0000-4000-8000-000000000002', 'e0e00000-0000-4000-8000-0000000000a1',
   'c0c00000-0000-4000-8000-000000000002', 'going', 0),
  ('b0b00000-0000-4000-8000-000000000003', 'e0e00000-0000-4000-8000-0000000000a1',
   'c0c00000-0000-4000-8000-000000000003', 'maybe', 0),
  ('b0b00000-0000-4000-8000-000000000004', 'e0e00000-0000-4000-8000-0000000000a1',
   'c0c00000-0000-4000-8000-000000000004', 'waitlisted', 0),
  -- Private event RSVPs.
  ('b0b00000-0000-4000-8000-000000000005', 'e0e00000-0000-4000-8000-0000000000a2',
   'c0c00000-0000-4000-8000-000000000005', 'going', 0),
  ('b0b00000-0000-4000-8000-000000000006', 'e0e00000-0000-4000-8000-0000000000a2',
   'c0c00000-0000-4000-8000-000000000006', 'not_going', 0)
on conflict (id) do nothing;

-- ── 5. Comments — host-authored + guest-authored (exactly one author each) ────
insert into public.comments (id, event_id, guest_id, host_id, body)
values
  -- Host welcome on the public event (host_id set, guest_id null).
  ('f0f00000-0000-4000-8000-000000000001', 'e0e00000-0000-4000-8000-0000000000a1',
   null, 'd0d00000-0000-4000-8000-000000000001', 'So hyped for this — doors at 6, come thirsty! 🥂'),
  -- Guest replies on the public event (guest_id set, host_id null).
  ('f0f00000-0000-4000-8000-000000000002', 'e0e00000-0000-4000-8000-0000000000a1',
   'c0c00000-0000-4000-8000-000000000001', null, 'Bringing my partner — can''t wait!'),
  ('f0f00000-0000-4000-8000-000000000003', 'e0e00000-0000-4000-8000-0000000000a1',
   'c0c00000-0000-4000-8000-000000000002', null, 'Should I bring anything?'),
  -- Host note on the private event.
  ('f0f00000-0000-4000-8000-000000000004', 'e0e00000-0000-4000-8000-0000000000a2',
   null, 'd0d00000-0000-4000-8000-000000000001', 'Vote for a date that works and I''ll lock it in.')
on conflict (id) do nothing;

-- ── 6. Date poll (on the date-TBD private event): options + votes ─────────────
insert into public.date_options (id, event_id, starts_at, ends_at)
values
  ('d1d00000-0000-4000-8000-000000000001', 'e0e00000-0000-4000-8000-0000000000a2',
   now() + interval '30 days', now() + interval '30 days' + interval '3 hours'),
  ('d1d00000-0000-4000-8000-000000000002', 'e0e00000-0000-4000-8000-0000000000a2',
   now() + interval '37 days', now() + interval '37 days' + interval '3 hours'),
  ('d1d00000-0000-4000-8000-000000000003', 'e0e00000-0000-4000-8000-0000000000a2',
   now() + interval '44 days', now() + interval '44 days' + interval '3 hours')
on conflict (id) do nothing;

-- Multi-select votes: Erin likes options 1 & 2; Frank likes option 2 (the
-- emerging consensus). Votes are preserved through finalize (SCHEMA §9–10).
insert into public.date_votes (id, date_option_id, guest_id)
values
  ('d2d00000-0000-4000-8000-000000000001', 'd1d00000-0000-4000-8000-000000000001',
   'c0c00000-0000-4000-8000-000000000005'),
  ('d2d00000-0000-4000-8000-000000000002', 'd1d00000-0000-4000-8000-000000000002',
   'c0c00000-0000-4000-8000-000000000005'),
  ('d2d00000-0000-4000-8000-000000000003', 'd1d00000-0000-4000-8000-000000000002',
   'c0c00000-0000-4000-8000-000000000006')
on conflict (id) do nothing;
