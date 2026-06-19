-- 0022_category_cardvariant_hostcontact.sql — Step-10A Task 1: the成局 DB foundation.
--
-- WHY THIS EXISTS (docs/prd/README.md "实现逻辑" + event-create / discover / settings
-- / event-card "实现逻辑"). Step-10A introduces the digital-ticket "局卡" and the
-- "成局" (event-fills/finalizes) loop. This migration is the PDF/visual-INDEPENDENT
-- DB layer that the later UI tasks build on. Three additive columns + two recreated
-- read RPCs; nothing destructive, no applied migration edited (CLAUDE.md rule 6).
--
--   • events.category    — 建局选分类: drives 局卡 design choice + sediments a backend
--                          category for future discovery/recommendation. Non-sensitive,
--                          part of the public card art → ALWAYS on the first-tier façade.
--   • events.card_variant— the host's chosen auto-generated 局卡 design. Non-sensitive,
--                          public card art → ALWAYS on the first-tier façade.
--   • profiles.contact   — host's GENERAL contact (host's own field). Guest-facing reveal
--                          is double-blind: shown ONLY through the gated get_event_by_slug
--                          block, exactly like host_wechat_id from R4 (locked + burn).
--
-- DB IS THE SECURITY BOUNDARY (CLAUDE.md). category / card_variant are non-sensitive
-- public façade fields — no column-level revoke. profiles.contact is the host's OWN
-- field; profiles RLS already restricts direct table reads to the owner, and the only
-- guest-facing path is the gated DEFINER RPC below — so no column-level revoke either
-- (mirrors how profiles.wechat_id was handled in R4: no revoke, gated read only).
--
-- get_event_by_slug and get_public_events are DROPPED and RECREATED here (never edited
-- in place). Both keep their exact signatures and return shapes; every existing field /
-- tier / gate is preserved byte-faithfully. search_path stays pinned empty; grants are
-- re-issued identically (anon / authenticated / service_role).

-- ── 1.1 Schema additions ──────────────────────────────────────────────────────────
alter table public.events add column category text;       -- 建局选分类 (public façade; drives 局卡)
alter table public.events add column card_variant text;    -- chosen 局卡 design (public façade)
alter table public.profiles add column contact text;       -- host GENERAL contact (gated reveal only, mirrors wechat_id from R4)

-- ── 1.2 Recreate get_event_by_slug — add public category/card_variant + gated host contact ─
-- Copied BYTE-FAITHFUL from 0021 (same 5-arg signature, same drop/recreate/grant) with
-- ONLY these Step-10A additions:
--   (1) 'category' + 'card_variant' on the first-tier façade (ALWAYS returned — the
--       public card art needs them; non-sensitive).
--   (2) host 'contact' fetched from profiles alongside wechat, revealed in the SAME
--       gated block as host_wechat_id — ONLY when v_is_unlocked AND v_contact_open
--       (double-blind + 阅后即焚, identical posture to host_wechat_id).
-- The guest_unlock_status(...) call (护栏 6 / G4), the private gate, the password gate,
-- and every tier are preserved byte-faithfully.
drop function if exists public.get_event_by_slug(text, uuid, text, boolean, uuid);

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
  v_event        public.events%rowtype;
  v_host_name    text;
  v_host_wechat  text;
  v_host_contact text;
  v_is_unlocked  boolean;
  v_is_locked    boolean;
  v_contact_open boolean;
  v_occupancy    integer;
  v_show_count   boolean;
  v_viewer_id    uuid;
  v_result       jsonb;
begin
  -- Resolve the event by slug. Unknown slug → null (no existence oracle).
  select * into v_event
  from public.events e
  where e.slug = get_event_by_slug.slug;

  if not found then
    return null;
  end if;

  -- ① Private gate (D3): only the trusted SSR path (service_role) may read a private
  -- event at all. Everyone else gets null.
  if v_event.visibility = 'private'
     and auth.role() is distinct from 'service_role' then
    return null;
  end if;

  -- ② Password gate. On failure return only the minimal locked response — nothing
  -- second-tier, and (round-4) no is_locked / host_wechat either.
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

  -- ③ Normal tiered response. The unlock decision comes ONLY from the shared gate
  -- helper (G4) — token scoped to THIS event, or the caller's linked account. The
  -- trusted viewer_id is HONOURED ONLY for service_role.
  v_viewer_id := case when auth.role() = 'service_role' then get_event_by_slug.viewer_id
                      else null end;

  select coalesce(gu.unlocked, false) into v_is_unlocked
  from public.guest_unlock_status(v_event.id, guest_token, v_viewer_id) gu;

  select p.display_name, p.wechat_id, p.contact into v_host_name, v_host_wechat, v_host_contact
  from public.profiles p
  where p.id = v_event.host_id;

  -- Round-4 lock + burn derivation (single source: the shared helpers).
  v_is_locked    := public.event_is_locked(v_event.locked_at, v_event.starts_at);
  v_contact_open := public.event_contact_open(v_event.locked_at, v_event.starts_at, v_event.ends_at);

  -- Occupancy = going headcount INCLUDING plus-ones (mirrors submit_rsvp's accounting).
  select coalesce(sum(1 + r.plus_ones), 0) into v_occupancy
  from public.rsvps r
  where r.event_id = v_event.id and r.status = 'going';

  -- Count rule (D7②).
  v_show_count := not v_event.hide_guest_count
                  and not (v_event.visibility = 'private' and not v_is_unlocked);

  -- First-tier façade — always returned once past the gates. is_locked is ALWAYS
  -- present here (round-4). category / card_variant are ALWAYS present (Step-10A: the
  -- public card art needs them; non-sensitive). No third-tier field is ever included.
  v_result := jsonb_build_object(
    'id',                  v_event.id,
    'slug',                v_event.slug,
    'title',               v_event.title,
    'description',         v_event.description,
    'cover_image_url',     v_event.cover_image_url,
    'theme',               v_event.theme,
    'effect',              v_event.effect,
    'category',            v_event.category,
    'card_variant',        v_event.card_variant,
    'location_city',       v_event.location_city,
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
    'is_locked',           v_is_locked,
    'unlocked',            v_is_unlocked
  );

  -- going_count / capacity_remaining added as KEYS only when visible.
  if v_show_count then
    v_result := v_result || jsonb_build_object(
      'going_count', v_occupancy,
      'capacity_remaining',
        case when v_event.capacity is null then null
             else greatest(v_event.capacity - v_occupancy, 0) end
    );
  end if;

  -- Second tier (sensitive): full address only after unlock.
  if v_is_unlocked then
    v_result := v_result || jsonb_build_object(
      'location_text', v_event.location_text,
      'location_url',  v_event.location_url
    );
  end if;

  -- Host wechat + host general contact: revealed to an UNLOCKED (RSVP'd) viewer only
  -- once the event is locked and still within the burn window (阅后即焚). A non-RSVP'd
  -- passerby never gets either. host_contact shares the IDENTICAL gate as host_wechat_id
  -- (double-blind, Step-10A settings PRD).
  if v_is_unlocked and v_contact_open then
    v_result := v_result || jsonb_build_object(
      'host_wechat_id', v_host_wechat,
      'host_contact',   v_host_contact
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.get_event_by_slug(text, uuid, text, boolean, uuid) from public;
grant execute on function public.get_event_by_slug(text, uuid, text, boolean, uuid)
  to anon, authenticated, service_role;

-- ── 1.3 Recreate get_public_events — add the 静默隐藏 (silent-hide) filter ────────────
-- Copied BYTE-FAITHFUL from 0020 (same no-arg signature, same return shape, FIRST-TIER
-- façade only) with ONLY this Step-10A addition: EXCLUDE "未成局-past" events from the
-- public discovery list (§5/§6 — no social death). An event is silently hidden when it
-- is PAST, had a target headcount it never filled, and was never manually locked:
--   • PAST           = coalesce(e.ends_at, e.starts_at) is not null AND now() >= it
--   • had a target   = e.capacity is not null
--   •未满 (going < capacity, plus-ones included, mirrors submit_rsvp accounting)
--   • NOT manually locked = e.locked_at is null
-- ⚠️ 成局 = 凑满 OR host MANUAL lock (locked_at non-null); the R4 auto-lock / is_locked
-- derivation does NOT count as 成局 here — do NOT use event_is_locked in this filter.
-- Open events (capacity null) are never hidden. The existing public+published filter and
-- every returned field are preserved.
create or replace function public.get_public_events()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  -- ONLY public + published events, across ALL hosts. private / draft /
  -- cancelled are never surfaced. host_display_name joined from profiles.
  -- 静默隐藏: a past event that set a target but never filled and was never manually
  -- locked is excluded (no social death) — see header.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',                e.id,
               'slug',              e.slug,
               'title',             e.title,
               'description',       e.description,
               'cover_image_url',   e.cover_image_url,
               'starts_at',         e.starts_at,
               'ends_at',           e.ends_at,
               'date_tbd',          e.date_tbd,
               'location_city',     e.location_city,
               'host_display_name', p.display_name
             )
             order by e.starts_at desc nulls last, e.created_at desc
           ),
           '[]'::jsonb
         )
    into v_result
  from (
    select e.*
    from public.events e
    where e.visibility = 'public'
      and e.status = 'published'
      and not (
        -- "未成局-past" silent-hide predicate.
        coalesce(e.ends_at, e.starts_at) is not null
        and now() >= coalesce(e.ends_at, e.starts_at)
        and e.capacity is not null
        and e.locked_at is null
        and (
          select coalesce(sum(1 + r.plus_ones), 0)
          from public.rsvps r
          where r.event_id = e.id and r.status = 'going'
        ) < e.capacity
      )
    order by e.starts_at desc nulls last, e.created_at desc
    limit 200
  ) e
  left join public.profiles p on p.id = e.host_id;

  return v_result;
end;
$$;

-- EXECUTE: anon is the primary caller (the public discovery page); authenticated
-- for a logged-in viewer; service_role for the SSR path. PUBLIC's implicit
-- default execute is replaced by these explicit grants.
revoke all on function public.get_public_events() from public;
grant execute on function public.get_public_events()
  to anon, authenticated, service_role;
