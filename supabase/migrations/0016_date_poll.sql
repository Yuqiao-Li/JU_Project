-- 0016_date_poll.sql — Task 5.1: the date-poll RPC layer the voting UI stands on.
--
-- The guest VOTE path (vote_dates) and the host FINALIZE path (finalize_date) already
-- exist (1.5e / 0011). Task 5.1 ("日期投票 UI") needs two pieces that 0011 did not
-- build, and both must be SECURITY DEFINER for the same architectural reason the rest
-- of the guest/host data plane is (SCHEMA 安全模型 §1/§2; 0004/0005; G1):
--
--   1. A READ path — get_date_poll. anon/guest have NO direct privilege on
--      date_options / date_votes (0004 grants the host SELECT-only; anon nothing), so
--      the public page's candidate list + live tally + "my current selection" can NOT
--      come from a direct table read. One DEFINER RPC returns all three, reusing the
--      shared unlock gate to resolve the caller's own votes and honouring the private
--      gate (D3) so a private event's poll is never readable by anon.
--
--   2. Host CANDIDATE MANAGEMENT — add_date_option / remove_date_option. `authenticated`
--      holds SELECT-only on date_options (0004: "every host-side write goes through a
--      DEFINER RPC … never client DML"), so 增删候选 can not be a client INSERT/DELETE.
--      These mirror finalize_date's HOST-ONLY gate exactly (D7③): auth.uid() IS NULL ⇒
--      reject (catches a service-role / no-JWT caller, whose host_id<>auth.uid() would
--      be NULL — i.e. NOT raise); then events.host_id <> auth.uid() ⇒ reject a non-owner.
--      auth.uid() reflects the CALLER's JWT even inside a DEFINER, so this is a true
--      per-caller check. errcode 42501 = insufficient_privilege.
--
-- VOTES ARE NOT TOUCHED HERE BY FINALIZE: finalize_date (0011) already keeps the poll
-- record on 敲定 (D7③). remove_date_option deletes a candidate the host explicitly chose
-- to drop, and that option's votes go with it via the date_votes ON DELETE CASCADE
-- (0003) — an intentional host action, not the finalize path the 禁止 guards.
--
-- All functions pin search_path empty (everything schema-qualified, incl. auth.uid()/
-- auth.role()) to harden the definers against search_path hijacking — same posture as
-- 0006/0007/0011.

-- ── get_date_poll(slug, guest_token?) → jsonb ────────────────────────────────
-- The single READ path for the date poll. Returns the event's candidate options, each
-- with its live vote tally, plus the caller's own current selection (my_option_ids)
-- resolved through the shared unlock gate — a forged / cross-event / absent token (or a
-- not_going RSVP, which does not unlock) yields an empty personal selection, never
-- another guest's. The tally itself is read-open (aggregate, like going_count): any
-- caller who may see the event may see the counts.
--
-- PRIVATE GATE (D3, owner-aware): a private event's poll is returned NULL unless the
-- caller is service_role (the trusted SSR path) OR the owning host (so the host can
-- manage their own private event's poll over their authed client). anon / another user
-- get NULL — a private event's candidate dates never leak. A public event's poll has no
-- gate. NULL is also returned for an unknown slug (no existence oracle).
create or replace function public.get_date_poll(
  slug        text,
  guest_token uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event    public.events%rowtype;
  v_guest_id uuid;
  v_unlocked boolean;
  v_options  jsonb;
  v_mine     jsonb;
begin
  select * into v_event
  from public.events e
  where e.slug = get_date_poll.slug;

  if not found then
    return null;
  end if;

  -- Private gate (D3): readable only by the trusted role or the owning host.
  if v_event.visibility = 'private'
     and auth.role() is distinct from 'service_role'
     and (auth.uid() is null or auth.uid() <> v_event.host_id) then
    return null;
  end if;

  -- Resolve the caller's unlock + guest_id through the shared gate (G4) — the same
  -- one vote_dates uses, so "can I vote / what did I pick" never drifts from "can I
  -- vote". A miss ⇒ unlocked=false, guest_id null.
  select gu.guest_id, coalesce(gu.unlocked, false)
    into v_guest_id, v_unlocked
  from public.guest_unlock_status(v_event.id, guest_token) gu;

  -- Candidate options with a live tally, ordered chronologically.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',        o.id,
               'starts_at', o.starts_at,
               'ends_at',   o.ends_at,
               'votes',     (select count(*)
                               from public.date_votes dv
                              where dv.date_option_id = o.id)
             )
             order by o.starts_at asc nulls last, o.created_at asc
           ),
           '[]'::jsonb
         )
    into v_options
  from public.date_options o
  where o.event_id = v_event.id;

  -- The caller's OWN current selection — only for an unlocked caller (a locked / absent
  -- caller has no personal selection to surface).
  if coalesce(v_unlocked, false) and v_guest_id is not null then
    select coalesce(jsonb_agg(dv.date_option_id), '[]'::jsonb)
      into v_mine
    from public.date_votes dv
    join public.date_options o on o.id = dv.date_option_id
    where o.event_id = v_event.id
      and dv.guest_id = v_guest_id;
  else
    v_mine := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'event_id',      v_event.id,
    'date_tbd',      v_event.date_tbd,
    -- finalized = the host has settled on a date (date_tbd cleared); the UI hides the
    -- poll then and shows the chosen date instead.
    'finalized',     (not v_event.date_tbd) and v_event.starts_at is not null,
    'starts_at',     v_event.starts_at,
    'ends_at',       v_event.ends_at,
    'unlocked',      coalesce(v_unlocked, false),
    'options',       v_options,
    'my_option_ids', v_mine
  );
end;
$$;

-- EXECUTE: anon is the primary reader (a guest's browser, with or without a token);
-- authenticated lets the owning host read their own poll; service_role for the trusted
-- SSR / poll endpoint. PUBLIC's implicit default execute is replaced.
revoke all on function public.get_date_poll(text, uuid) from public;
grant execute on function public.get_date_poll(text, uuid)
  to anon, authenticated, service_role;

-- ── add_date_option(event_id, starts_at, ends_at?) → jsonb ───────────────────
-- HOST-ONLY (D7③): append a candidate date to the host's own event's poll. Same
-- host-auth gate as finalize_date — see header. starts_at is required (the column is
-- NOT NULL); an explicit guard gives a clean message instead of a constraint error.
create or replace function public.add_date_option(
  event_id  uuid,
  starts_at timestamptz,
  ends_at   timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events%rowtype;
  v_id    uuid;
begin
  -- ① Real auth context required (D7③): a service-role / no-JWT caller has a null
  -- auth.uid() and is rejected here, BEFORE the host comparison (which would itself be
  -- NULL for a null uid — i.e. not raise).
  if auth.uid() is null then
    raise exception 'authentication required to add a date option'
      using errcode = '42501';
  end if;

  if add_date_option.starts_at is null then
    raise exception 'a date option needs a start time';
  end if;

  select * into v_event
  from public.events e
  where e.id = add_date_option.event_id;

  if not found then
    raise exception 'event not found';
  end if;

  -- ② Host-only: only the owning host may add a candidate to their own event.
  if v_event.host_id <> auth.uid() then
    raise exception 'only the host can add a date option'
      using errcode = '42501';
  end if;

  insert into public.date_options (event_id, starts_at, ends_at)
  values (v_event.id, add_date_option.starts_at, add_date_option.ends_at)
  returning id into v_id;

  return jsonb_build_object(
    'id',        v_id,
    'event_id',  v_event.id,
    'starts_at', add_date_option.starts_at,
    'ends_at',   add_date_option.ends_at
  );
end;
$$;

-- EXECUTE: authenticated (the host) + service_role (so the D7③ rejection is exercised
-- INSIDE the function rather than at the privilege layer). anon is never an adder.
revoke all on function public.add_date_option(uuid, timestamptz, timestamptz) from public;
grant execute on function public.add_date_option(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

-- ── remove_date_option(option_id) → jsonb ────────────────────────────────────
-- HOST-ONLY (D7③): drop a candidate from the host's own event's poll. The option's
-- votes are removed with it via the date_votes ON DELETE CASCADE (0003) — an explicit
-- host removal, distinct from finalize (which keeps votes). Same host-auth gate.
create or replace function public.remove_date_option(
  option_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_option public.date_options%rowtype;
  v_event  public.events%rowtype;
begin
  -- ① Real auth context required (D7③) — see add_date_option / header.
  if auth.uid() is null then
    raise exception 'authentication required to remove a date option'
      using errcode = '42501';
  end if;

  select * into v_option
  from public.date_options d
  where d.id = remove_date_option.option_id;

  if not found then
    raise exception 'date option not found';
  end if;

  select * into v_event
  from public.events e
  where e.id = v_option.event_id;

  if not found then
    raise exception 'event not found';
  end if;

  -- ② Host-only: only the owning host may remove a candidate from their own event.
  if v_event.host_id <> auth.uid() then
    raise exception 'only the host can remove a date option'
      using errcode = '42501';
  end if;

  delete from public.date_options d where d.id = v_option.id;

  return jsonb_build_object(
    'option_id', v_option.id,
    'event_id',  v_event.id
  );
end;
$$;

-- EXECUTE: authenticated (the host) + service_role (exercises the D7③ in-function
-- rejection). anon never removes.
revoke all on function public.remove_date_option(uuid) from public;
grant execute on function public.remove_date_option(uuid)
  to authenticated, service_role;
