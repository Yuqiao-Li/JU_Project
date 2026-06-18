-- 0016_get_my_events_counts.sql (task 5 / audit H9)
--
-- Adds per-event RSVP counts to get_my_events so the dashboard can show responses
-- at a glance ("12 going · 2 waitlist") instead of forcing the host to open each
-- event. CREATE OR REPLACE preserves the existing EXECUTE grants. The counts are
-- aggregate numbers only (no PII); the function stays SECURITY DEFINER and still
-- only surfaces events the caller hosts or attends (unchanged predicate). going_count
-- is OCCUPANCY (1 + plus_ones per going RSVP), matching the event detail page.

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
               'role',            case when e.host_id = v_uid then 'host' else 'guest' end,
               'going_count',     (
                 select coalesce(sum(1 + r.plus_ones), 0)::int
                 from public.rsvps r
                 where r.event_id = e.id and r.status = 'going'
               ),
               'maybe_count',     (
                 select count(*)::int
                 from public.rsvps r
                 where r.event_id = e.id and r.status = 'maybe'
               ),
               'waitlist_count',  (
                 select count(*)::int
                 from public.rsvps r
                 where r.event_id = e.id and r.status = 'waitlisted'
               )
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
