-- ── get_public_events() → jsonb ──────────────────────────────────────────────
-- Round-3 #6: the site-wide event DISCOVERY page (/discover). Returns EVERY
-- public + published event across all hosts — never private, never a draft,
-- never cancelled. Modeled on get_public_events_by_host (0011) but with NO host
-- filter and NO args; adds host_display_name (joined from profiles) so a
-- discovery card can show who is hosting.
--
-- DEFINER so anon can read this curated subset WITHOUT any direct table grant
-- (anon must never SELECT events directly, G1). The function is the security
-- boundary: FIRST-TIER façade fields ONLY — no location_text (address), no guest
-- list, no contact, no second/third-tier field, and no private/draft/cancelled
-- event ever leaks (so no existence oracle for non-public events).
--
-- Bounded by LIMIT 200 so the public list can never become an unbounded payload.
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
