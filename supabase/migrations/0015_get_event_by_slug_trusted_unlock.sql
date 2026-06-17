-- 0015_get_event_by_slug_trusted_unlock.sql — Task 2.5 [🟢]: password protection.
--
-- WHY THIS EXISTS (D7⑤/amend; SCHEMA "verify_event_password … 通过发短时签名凭证(cookie),
-- 后续读/轮询不再重跑 bcrypt"). A guest unlocks a password event ONCE via
-- verify_event_password (one bcrypt). To then reload / poll WITHOUT re-hashing on every
-- read, the Next trusted layer mints a short-lived HMAC-signed cookie credential
-- (web/lib/events/password-credential.ts). On a later read it validates that cheap MAC
-- and tells THIS function the password is already satisfied — instead of forwarding the
-- plaintext password (which would force bcrypt every read AND would mean storing the
-- plaintext in the cookie, both forbidden by the 2.5 禁止 line).
--
-- THE CHANGE vs 0007. `get_event_by_slug` gains a 4th argument `password_verified
-- boolean default false`. The password gate (② SCHEMA "私密 + 密码闸顺序") is bypassed
-- ONLY when `password_verified` is true AND the caller is `service_role` — i.e. the
-- trusted SSR/Route-Handler path that actually validated the signed cookie. Everything
-- else is unchanged:
--   • A plain SSR load (no cookie ⇒ password_verified defaults false) still returns the
--     locked façade — a password event never leaks the address to anyone with the link
--     until the password (or a valid credential) is presented. The 0007 header's
--     "service_role does NOT bypass" still holds for the DEFAULT call; the bypass is
--     opt-in and gated on a trusted, already-verified credential.
--   • An anon caller passing password_verified=true directly is IGNORED (auth.role() is
--     'anon', not 'service_role') ⇒ it can never self-grant past the gate.
--   • The private gate (①), the unlock helper (③), the count rule (D7②) and every field
--     tier are byte-for-byte the 0007 logic. The shared gate helper
--     `public.guest_unlock_status(` is STILL the only unlock predicate (G4 / 护栏 6).
--
-- Additive, per CLAUDE.md: 0007's 3-arg function is dropped and recreated with the new
-- signature in THIS new migration (an applied migration is never edited). search_path
-- stays pinned empty.

drop function if exists public.get_event_by_slug(text, uuid, text);

create or replace function public.get_event_by_slug(
  slug              text,
  guest_token       uuid    default null,
  password          text    default null,
  password_verified boolean default false
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
  -- (G4) — token scoped to THIS event, or the caller's linked account. Forged /
  -- cross-event / absent token ⇒ unlocked=false ⇒ address & list stay hidden.
  select coalesce(gu.unlocked, false) into v_is_unlocked
  from public.guest_unlock_status(v_event.id, guest_token) gu;

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

revoke all on function public.get_event_by_slug(text, uuid, text, boolean) from public;
grant execute on function public.get_event_by_slug(text, uuid, text, boolean)
  to anon, authenticated, service_role;
