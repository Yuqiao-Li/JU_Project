-- 0018_get_event_by_slug_account_unlock.sql — audit H16: cross-device account unlock.
--
-- WHY THIS EXISTS (SCHEMA D1 "logged-in user's RSVP linked via guests.user_id … so it
-- shows up in their own events"; the account-fallback branch of guest_unlock_status).
-- A logged-in user who RSVP'd on one device should re-see the unlocked tier on another
-- device WITHOUT a localStorage token — their account (guests.user_id = auth.uid())
-- already unlocks. But the PUBLIC read path runs through `readEventBySlug`, which calls
-- get_event_by_slug as the TRUSTED service role so private events resolve server-side
-- only. Under service_role `auth.uid()` is NULL, so guest_unlock_status's account branch
-- never fires on the SSR path — the user sees a LOCKED page and is pushed to re-RSVP
-- (risking a duplicate guest). This migration plumbs the viewer's identity through the
-- trusted path so the account branch can match it, mirroring how 0015 added a trusted
-- `password_verified` honoured ONLY for service_role.
--
-- THE CHANGE.
--   • guest_unlock_status gains an optional trusted `viewer_id uuid` (4th arg). The
--     account branch now matches `g.user_id = coalesce(auth.uid(), viewer_id)`:
--       - On a guest/anon/authenticated DIRECT call viewer_id is null (default), so the
--         branch reduces to the EXACT 0006 behaviour (`g.user_id = auth.uid()` when a
--         JWT is present). No widening for anyone calling the helper directly.
--       - On the trusted SSR path (service_role, auth.uid() = NULL) the Next layer passes
--         the viewer's own auth.uid() as viewer_id, so the account branch fires. The
--         helper is SECURITY DEFINER reading guests/rsvps regardless of RLS, exactly as
--         before — it still only reports the gate status of a row the caller proves they
--         own (their linked account, or the unguessable token).
--   • get_event_by_slug gains an optional trusted `viewer_id uuid` (5th arg) that is
--     HONOURED ONLY when `auth.role() = 'service_role'` — the same trusted-only posture
--     as password_verified (0015). A non-service-role caller passing viewer_id is
--     ignored (forced to null), so it can NEVER self-grant a unlock for another account.
--     The value is threaded into the SAME shared gate helper (G4 / 护栏 6 still greps
--     this body for the `guest_unlock_status(` call — it's still the only unlock
--     predicate, inlining nothing).
--
-- EVERYTHING ELSE IS UNCHANGED from 0015: the private gate (①), the password gate (②,
-- incl. the trusted password_verified bypass), the count rule (D7②) and every field
-- tier are byte-for-byte the 0015 logic. Additive per CLAUDE.md: the applied 0006/0015
-- functions are dropped and recreated with the new signatures here (never edited in
-- place). search_path stays pinned empty.

-- ── guest_unlock_status(event_id, token?, viewer_id?) — add trusted viewer_id ──────
-- Drop the 0006 2-arg form before recreating with the extra trusted input. plpgsql
-- callers resolve guest_unlock_status by name at call time, so the 5 existing 2-positional
-- callers (get_event_by_slug / get_guest_list / add_comment / vote / date poll) bind to
-- this new form unchanged (viewer_id defaults to null ⇒ their behaviour is identical).
drop function if exists public.guest_unlock_status(uuid, uuid);

create or replace function public.guest_unlock_status(
  event_id  uuid,
  token     uuid default null,
  viewer_id uuid default null,
  out guest_id uuid,
  out unlocked boolean,
  out status   text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- The effective account identity: the caller's own JWT (auth.uid()) when present,
  -- else the trusted viewer_id forwarded by the service-role SSR path. On a direct
  -- guest call viewer_id is null, so this is exactly auth.uid() — unchanged from 0006.
  v_account uuid := coalesce(auth.uid(), viewer_id);
begin
  -- Match the guest by token (event-scoped) OR by linked account, then read the RSVP
  -- status. Token is the primary credential, so when both branches could match the token
  -- row wins (ORDER BY token-match-first + LIMIT 1). When `token` is null only the
  -- account branch can match (g.guest_token = null is never true).
  select g.id,
         (r.status in ('going', 'maybe', 'waitlisted')),
         r.status
    into guest_id, unlocked, status
  from public.guests g
  join public.rsvps  r on r.guest_id = g.id
  where g.event_id = guest_unlock_status.event_id
    and (
      g.guest_token = guest_unlock_status.token
      or (v_account is not null and g.user_id = v_account)
    )
  order by (g.guest_token = guest_unlock_status.token) desc nulls last
  limit 1;

  -- No matching guest/RSVP: force the gate closed. guest_id/status stay null.
  if not found then
    unlocked := false;
  end if;
end;
$$;

revoke all on function public.guest_unlock_status(uuid, uuid, uuid) from public;
grant execute on function public.guest_unlock_status(uuid, uuid, uuid)
  to anon, authenticated, service_role;

-- ── get_event_by_slug(slug, guest_token?, password?, password_verified?, viewer_id?) ──
drop function if exists public.get_event_by_slug(text, uuid, text, boolean);

create or replace function public.get_event_by_slug(
  slug              text,
  guest_token       uuid    default null,
  password          text    default null,
  password_verified boolean default false,
  viewer_id         uuid    default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event       public.events%rowtype;
  v_host_name   text;
  v_is_unlocked boolean;
  v_occupancy   integer;
  v_show_count  boolean;
  v_viewer_id   uuid;
  v_result      jsonb;
begin
  -- Resolve the event by slug. Unknown slug → null (no existence oracle).
  select * into v_event
  from public.events e
  where e.slug = get_event_by_slug.slug;

  if not found then
    return null;
  end if;

  -- ① Private gate (D3): only the trusted SSR path (service_role) may read a private
  -- event at all. Everyone else — anon, an authenticated guest — gets null.
  if v_event.visibility = 'private'
     and auth.role() is distinct from 'service_role' then
    return null;
  end if;

  -- ② Password gate. A hash present means the caller must present the matching password
  -- OR a valid credential. The TRUSTED bypass: when the Next layer has already validated
  -- the signed cookie it calls with password_verified=true AS service_role, letting the
  -- read resume normal tiering WITHOUT re-running bcrypt. A non-service-role caller's
  -- password_verified is ignored (it can't self-grant). On failure return only the
  -- minimal locked response (title/cover/description) — nothing second-tier.
  if v_event.view_password_hash is not null
     and not (get_event_by_slug.password_verified and auth.role() = 'service_role')
     and (password is null
          or v_event.view_password_hash <> extensions.crypt(password, v_event.view_password_hash)) then
    return jsonb_build_object(
      'slug',             v_event.slug,
      'title',            v_event.title,
      'description',      v_event.description,
      'cover_image_url',  v_event.cover_image_url,
      'visibility',       v_event.visibility,
      'requires_password', true,
      'locked',           true,
      'unlocked',         false
    );
  end if;

  -- ③ Normal tiered response. The unlock decision comes ONLY from the shared gate helper
  -- (G4) — token scoped to THIS event, or the caller's linked account. The trusted
  -- viewer_id is HONOURED ONLY for service_role (the SSR path that vouches for the
  -- session): it lets a logged-in user unlock across devices without a localStorage
  -- token (audit H16 / D1). A non-service-role caller's viewer_id is forced to null so it
  -- can never self-grant another account's unlock. Forged / cross-event / absent token
  -- (and no matching account) ⇒ unlocked=false ⇒ address & list stay hidden.
  v_viewer_id := case when auth.role() = 'service_role' then get_event_by_slug.viewer_id
                      else null end;

  select coalesce(gu.unlocked, false) into v_is_unlocked
  from public.guest_unlock_status(v_event.id, guest_token, v_viewer_id) gu;

  select p.display_name into v_host_name
  from public.profiles p
  where p.id = v_event.host_id;

  -- Occupancy = going headcount INCLUDING plus-ones (mirrors submit_rsvp's capacity
  -- accounting, D7①). plus_ones is NOT NULL default 0.
  select coalesce(sum(1 + r.plus_ones), 0) into v_occupancy
  from public.rsvps r
  where r.event_id = v_event.id and r.status = 'going';

  -- Count rule (D7②): show going_count/capacity_remaining unless hide_guest_count, or
  -- the event is private and the caller is not unlocked. When false the keys are OMITTED.
  v_show_count := not v_event.hide_guest_count
                  and not (v_event.visibility = 'private' and not v_is_unlocked);

  -- First-tier façade — always returned once past the gates. No third-tier field
  -- (contact / other tokens / raw hash / Can't-Go / answers) is ever included.
  v_result := jsonb_build_object(
    'id',                  v_event.id,
    'slug',                v_event.slug,
    'title',               v_event.title,
    'description',         v_event.description,
    'cover_image_url',     v_event.cover_image_url,
    'theme',               v_event.theme,
    'effect',              v_event.effect,
    'location_city',       v_event.location_city,   -- city-level only (first tier)
    'starts_at',           v_event.starts_at,
    'ends_at',             v_event.ends_at,
    'date_tbd',            v_event.date_tbd,
    'host_display_name',   v_host_name,
    'rsvp_enabled',        v_event.rsvp_enabled,
    'visibility',          v_event.visibility,
    'capacity',            v_event.capacity,
    'allow_plus_ones',     v_event.allow_plus_ones,
    'max_plus_ones',       v_event.max_plus_ones,
    'hide_guest_list',     v_event.hide_guest_list,
    'hide_guest_count',    v_event.hide_guest_count,
    'hide_feed_timestamps', v_event.hide_feed_timestamps,
    'chip_in_url',         v_event.chip_in_url,
    'chip_in_note',        v_event.chip_in_note,
    'status',              v_event.status,
    'requires_password',   v_event.view_password_hash is not null,
    'locked',              false,
    'unlocked',            v_is_unlocked
  );

  -- going_count / capacity_remaining added as KEYS only when visible (capacity null ⇒
  -- unlimited ⇒ remaining null). Absent entirely otherwise.
  if v_show_count then
    v_result := v_result || jsonb_build_object(
      'going_count', v_occupancy,
      'capacity_remaining',
        case when v_event.capacity is null then null
             else greatest(v_event.capacity - v_occupancy, 0) end
    );
  end if;

  -- Second tier (sensitive): full address only after unlock. The guest list and the
  -- comment-post right are separate RPCs; the `unlocked` flag above is the client's
  -- signal to fetch them.
  if v_is_unlocked then
    v_result := v_result || jsonb_build_object(
      'location_text', v_event.location_text,
      'location_url',  v_event.location_url
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.get_event_by_slug(text, uuid, text, boolean, uuid) from public;
grant execute on function public.get_event_by_slug(text, uuid, text, boolean, uuid)
  to anon, authenticated, service_role;
