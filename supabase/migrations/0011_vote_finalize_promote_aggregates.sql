-- 0011_vote_finalize_promote_aggregates.sql — Task 1.5e [SECURITY]: the date-poll
-- write path, the two host-only mutations, and the two aggregate reads:
--   * vote_dates(slug, guest_token, option_ids[]) — guest multi-select upsert over a
--     date poll (去掉未选项); unlock-gated; only ever touches the caller's own votes.
--   * finalize_date(event_id, option_id) — HOST-ONLY: write the chosen option back to
--     events.starts_at/ends_at + date_tbd=false, KEEPING the votes (D7③).
--   * promote_guest(rsvp_id) — HOST-ONLY: waitlist→going, respecting capacity (D7③).
--   * get_my_events() — D1: events I host (host_id) + events I attend (guests.user_id).
--   * get_public_events_by_host(username) — D2: an Organizer Profile's public list.
-- TASKS.md labels this "(0005f)".
--
-- Named 0011_* (logical "0005f"): the Supabase CLI only applies files whose version
-- prefix is purely numeric, so the physical numbering runs one ahead of the logical
-- labels (1.1a=0001 … 1.5c=0009, 1.5d=0010, 1.5e=0011). This sorts right after
-- 0010_add_comment.sql — see the 0002…0010 headers for the same note.
--
-- WHY THESE EXIST (SCHEMA 安全模型 §1/§2 单一读写路径; D1/D2/D7③; G1).
-- `anon`/`authenticated` guests have NO direct privilege on the client-data tables
-- (0004/0005); every guest read/write reaches them ONLY through a SECURITY DEFINER
-- RPC that runs as the table-owning migration role (bypassing RLS) and self-validates
-- its inputs. The two host-only mutations are DEFINER too — hosts hold only SELECT
-- (not UPDATE) on rsvps, and promote/finalize must write — so the authorisation can
-- NOT be RLS here; it is the explicit `auth.uid() = events.host_id` check inside each
-- function. The two aggregate reads are DEFINER because they must cross ownership
-- boundaries safely (get_my_events reads a guests row that belongs to SOMEONE ELSE's
-- event when I merely attend; get_public_events_by_host serves anon a curated subset).
--
-- HOST-ONLY AUTHORISATION (D7③, pinned — TEST-SPEC §1.5e):
--   finalize_date / promote_guest must be called in a REAL host auth context. The
--   gate is, in order:
--     ① auth.uid() IS NULL  → reject. This is the part that catches a service-role
--        (or any no-JWT) caller: `host_id <> auth.uid()` would evaluate to NULL — which
--        `if` treats as false and would NOT raise — so without this explicit null guard
--        a service-role call could slip through and finalize/promote. The independent
--        TEST-SPEC §1.5e asserts a service-role call (no auth context) is rejected.
--     ② events.host_id <> auth.uid()  → reject (a non-host / another host).
--   auth.uid() reflects the CALLER's JWT even inside SECURITY DEFINER (it reads the
--   request.jwt.claims session GUC, not the function's owner), so this is a true
--   per-caller check, not the definer's identity. errcode 42501 = insufficient_privilege.
--
-- VOTES SURVIVE FINALIZE (SCHEMA §9–10, D7③): finalize_date only writes events; it
-- never deletes date_options/date_votes. The poll record is kept ("保留投票记录").
--
-- All functions pin search_path empty (everything schema-qualified, incl. auth.uid();
-- pg_catalog built-ins resolve implicitly) to harden the definers against search_path
-- hijacking — same posture as 0002/0006/0007/0008/0009/0010.

-- ── vote_dates(slug, guest_token, option_ids[]) → jsonb ───────────────────────
-- The guest date-poll write path. Multi-select UPSERT: the passed option_ids become
-- the guest's COMPLETE new selection — options added, de-selected options removed
-- (去掉未选项), so re-voting with a different set replaces the old one. Reuses the
-- shared unlock gate (公门禁只一处) both to require an unlocking RSVP and to resolve
-- the author guest_id server-side — a forged / cross-event / absent token ⇒
-- unlocked=false ⇒ rejected, and not_going never unlocks. Option ids are filtered to
-- THIS event's options, so a foreign/forged option_id is silently dropped (never
-- inserted) and the delete can never reach another event's votes.
create or replace function public.vote_dates(
  slug        text,
  guest_token uuid     default null,
  option_ids  uuid[]   default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event    public.events%rowtype;
  v_guest_id uuid;
  v_unlocked boolean;
  v_options  uuid[];
begin
  -- Resolve the event by slug. Unknown slug → error (no poll to write to).
  select * into v_event
  from public.events e
  where e.slug = vote_dates.slug;

  if not found then
    raise exception 'event not found';
  end if;

  if v_event.status = 'cancelled' then
    raise exception 'event is cancelled';
  end if;

  -- Write gate (G4): the caller must be UNLOCKED, decided ONLY by the shared helper —
  -- token scoped to THIS event, or the caller's linked account. The helper also
  -- RESOLVES the voter's guest_id, so the vote is bound to the verified credential,
  -- not to anything the client sent. Forged / cross-event / absent token ⇒
  -- unlocked=false ⇒ rejected (not_going does not unlock either).
  select gu.guest_id, coalesce(gu.unlocked, false)
    into v_guest_id, v_unlocked
  from public.guest_unlock_status(v_event.id, guest_token) gu;

  if not coalesce(v_unlocked, false) then
    raise exception 'RSVP required to vote on dates' using errcode = 'P0001';
  end if;

  -- Keep ONLY option ids that genuinely belong to THIS event; foreign/forged ids are
  -- dropped here so they can never be inserted nor influence the delete below.
  select coalesce(array_agg(d.id), '{}'::uuid[])
    into v_options
  from public.date_options d
  where d.event_id = v_event.id
    and d.id = any (coalesce(option_ids, '{}'::uuid[]));

  -- Add the selected votes (idempotent on unique(date_option_id, guest_id)) …
  insert into public.date_votes (date_option_id, guest_id)
  select unnest(v_options), v_guest_id
  on conflict (date_option_id, guest_id) do nothing;

  -- … then remove this guest's votes for THIS event's options NOT in the new
  -- selection (去掉未选项). Scoped through date_options to v_event so it never
  -- touches another event. Empty selection ⇒ every vote of this guest is cleared.
  delete from public.date_votes dv
  using public.date_options d
  where dv.date_option_id = d.id
    and d.event_id = v_event.id
    and dv.guest_id = v_guest_id
    and not (dv.date_option_id = any (v_options));

  -- Confirmation: the guest's current selection (the sanitized set we applied).
  return jsonb_build_object(
    'event_id',            v_event.id,
    'selected_option_ids', to_jsonb(v_options)
  );
end;
$$;

-- EXECUTE: anon is the primary voter (a guest's browser presenting their token);
-- authenticated lets an account-linked guest vote; service_role for the trusted SSR
-- path that forwards the guest's token. PUBLIC's implicit default execute is replaced.
revoke all on function public.vote_dates(text, uuid, uuid[]) from public;
grant execute on function public.vote_dates(text, uuid, uuid[])
  to anon, authenticated, service_role;

-- ── finalize_date(event_id, option_id) → jsonb ───────────────────────────────
-- HOST-ONLY (D7③): write the chosen date option back onto the event and clear the
-- TBD flag. Votes are intentionally NOT deleted (保留投票记录). See header for the
-- host-auth gate (null caller ⇒ reject catches service-role; non-host ⇒ reject).
create or replace function public.finalize_date(
  event_id  uuid,
  option_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event  public.events%rowtype;
  v_option public.date_options%rowtype;
begin
  -- ① Real auth context required (D7③): a service-role / no-JWT caller has a null
  -- auth.uid() and is rejected here (BEFORE the host comparison, which would itself
  -- evaluate to NULL — i.e. not raise — for a null uid).
  if auth.uid() is null then
    raise exception 'authentication required to finalize the date'
      using errcode = '42501';
  end if;

  select * into v_event
  from public.events e
  where e.id = finalize_date.event_id;

  if not found then
    raise exception 'event not found';
  end if;

  -- ② Host-only: only the owning host may finalize their own event's date.
  if v_event.host_id <> auth.uid() then
    raise exception 'only the host can finalize the date'
      using errcode = '42501';
  end if;

  -- The option must belong to THIS event (no cross-event finalize).
  select * into v_option
  from public.date_options d
  where d.id = finalize_date.option_id
    and d.event_id = v_event.id;

  if not found then
    raise exception 'date option not found for this event';
  end if;

  -- Write the chosen date; clear date_tbd. The events BEFORE UPDATE trigger bumps
  -- updated_at. date_options / date_votes are left untouched (votes are kept, D7③).
  update public.events e
     set starts_at = v_option.starts_at,
         ends_at   = v_option.ends_at,
         date_tbd  = false
   where e.id = v_event.id;

  return jsonb_build_object(
    'event_id',  v_event.id,
    'option_id', v_option.id,
    'starts_at', v_option.starts_at,
    'ends_at',   v_option.ends_at,
    'date_tbd',  false
  );
end;
$$;

-- EXECUTE: authenticated only carries a real host auth context; service_role is
-- granted so the D7③ rejection is exercised INSIDE the function (the call reaches the
-- null-auth.uid() guard and raises) rather than failing at the privilege layer. anon
-- is not granted — finalize is never an anonymous action.
revoke all on function public.finalize_date(uuid, uuid) from public;
grant execute on function public.finalize_date(uuid, uuid)
  to authenticated, service_role;

-- ── promote_guest(rsvp_id) → jsonb ───────────────────────────────────────────
-- HOST-ONLY (D7③): move a waitlisted RSVP to 'going', RESPECTING capacity. Same
-- host-auth gate as finalize_date. The capacity check runs inside the same per-event
-- advisory lock submit_rsvp uses, so a promote can never race a concurrent submit to
-- oversell the last seat.
create or replace function public.promote_guest(
  rsvp_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rsvp      public.rsvps%rowtype;
  v_event     public.events%rowtype;
  v_occupancy integer;
begin
  -- ① Real auth context required (D7③) — see finalize_date / header.
  if auth.uid() is null then
    raise exception 'authentication required to promote a guest'
      using errcode = '42501';
  end if;

  select * into v_rsvp
  from public.rsvps r
  where r.id = promote_guest.rsvp_id;

  if not found then
    raise exception 'rsvp not found';
  end if;

  select * into v_event
  from public.events e
  where e.id = v_rsvp.event_id;

  if not found then
    raise exception 'event not found';
  end if;

  -- ② Host-only: only the owning host may promote a guest on their own event.
  if v_event.host_id <> auth.uid() then
    raise exception 'only the host can promote a guest'
      using errcode = '42501';
  end if;

  -- Only a waitlisted RSVP can be promoted (waitlist→going).
  if v_rsvp.status <> 'waitlisted' then
    raise exception 'only a waitlisted guest can be promoted';
  end if;

  -- Per-event serialization for the capacity decision (mirrors submit_rsvp D7①), so
  -- promote and concurrent submits cannot both consume the last seat.
  perform pg_advisory_xact_lock(hashtext(v_event.id::text));

  -- Respect capacity: occupancy = going headcount incl. plus-ones, EXCLUDING this
  -- guest's own row. NULL capacity = unlimited. Refuse if the seat doesn't fit.
  if v_event.capacity is not null then
    select coalesce(sum(1 + r.plus_ones), 0) into v_occupancy
    from public.rsvps r
    where r.event_id = v_event.id
      and r.status = 'going'
      and r.guest_id <> v_rsvp.guest_id;

    if v_occupancy + (1 + v_rsvp.plus_ones) > v_event.capacity then
      raise exception 'not enough capacity to promote this guest'
        using errcode = 'P0001';
    end if;
  end if;

  -- Promote. The rsvps BEFORE UPDATE trigger maintains updated_at.
  update public.rsvps r
     set status = 'going'
   where r.id = v_rsvp.id;

  return jsonb_build_object(
    'rsvp_id',  v_rsvp.id,
    'event_id', v_event.id,
    'guest_id', v_rsvp.guest_id,
    'status',   'going'
  );
end;
$$;

-- EXECUTE: authenticated (the host) + service_role (exercises the D7③ in-function
-- rejection). anon is never a promoter.
revoke all on function public.promote_guest(uuid) from public;
grant execute on function public.promote_guest(uuid)
  to authenticated, service_role;

-- ── get_my_events() → jsonb ──────────────────────────────────────────────────
-- D1: the unified "your events" feed for the logged-in user — events I HOST
-- (host_id = auth.uid()) UNIONed with events I ATTEND (a guests row links my account
-- via user_id). Each event appears once with a `role` discriminator so the dashboard
-- can split host/going. DEFINER because the attend branch reads a guests row that
-- belongs to ANOTHER host's event — the caller has no RLS path to it — yet we only
-- ever surface events the caller is genuinely tied to. Desensitized list view:
-- first-tier fields only (location_CITY, never the full location_text); the per-event
-- detail page applies the tiered reveal.
create or replace function public.get_my_events()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_result jsonb;
begin
  -- No auth context ⇒ nothing is "mine". Empty array (uniform type, no oracle).
  if v_uid is null then
    return '[]'::jsonb;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',              e.id,
               'slug',            e.slug,
               'title',           e.title,
               'cover_image_url', e.cover_image_url,
               'starts_at',       e.starts_at,
               'ends_at',         e.ends_at,
               'date_tbd',        e.date_tbd,
               'location_city',   e.location_city,
               'visibility',      e.visibility,
               'status',          e.status,
               -- host_id is the authority (D9): if I host it, role='host' even if I
               -- also have a guest row; otherwise I'm an attendee.
               'role',            case when e.host_id = v_uid then 'host' else 'guest' end
             )
             order by e.starts_at asc nulls last, e.created_at desc
           ),
           '[]'::jsonb
         )
    into v_result
  from public.events e
  where e.host_id = v_uid
     or exists (
       select 1 from public.guests g
       where g.event_id = e.id and g.user_id = v_uid
     );

  return v_result;
end;
$$;

-- EXECUTE: authenticated is the only meaningful caller (auth.uid()); service_role for
-- the trusted SSR path that runs with the user's session. anon always gets [].
revoke all on function public.get_my_events() from public;
grant execute on function public.get_my_events()
  to authenticated, service_role;

-- ── get_public_events_by_host(username) → jsonb ──────────────────────────────
-- D2: the Organizer Profile (/u/[username]) public event list. Resolves the username
-- to a host and returns ONLY their public + published events — never private, never a
-- draft. DEFINER so anon can read this curated subset WITHOUT any direct table grant
-- (anon must never SELECT events directly, G1). First-tier fields only.
create or replace function public.get_public_events_by_host(
  username text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_host_id uuid;
  v_result  jsonb;
begin
  -- Resolve the username → host. Unknown username → empty list (no existence oracle).
  select p.id into v_host_id
  from public.profiles p
  where p.username = get_public_events_by_host.username;

  if not found then
    return '[]'::jsonb;
  end if;

  -- ONLY public + published events. private / draft / cancelled are never surfaced.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',              e.id,
               'slug',            e.slug,
               'title',           e.title,
               'description',     e.description,
               'cover_image_url', e.cover_image_url,
               'starts_at',       e.starts_at,
               'ends_at',         e.ends_at,
               'date_tbd',        e.date_tbd,
               'location_city',   e.location_city
             )
             order by e.starts_at desc nulls last, e.created_at desc
           ),
           '[]'::jsonb
         )
    into v_result
  from public.events e
  where e.host_id = v_host_id
    and e.visibility = 'public'
    and e.status = 'published';

  return v_result;
end;
$$;

-- EXECUTE: anon is the primary caller (a public profile page); authenticated for a
-- logged-in viewer; service_role for the SSR path. PUBLIC's implicit default execute
-- is replaced by these explicit grants.
revoke all on function public.get_public_events_by_host(text) from public;
grant execute on function public.get_public_events_by_host(text)
  to anon, authenticated, service_role;
