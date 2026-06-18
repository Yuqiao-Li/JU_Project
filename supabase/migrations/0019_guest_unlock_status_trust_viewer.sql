-- 0019_guest_unlock_status_trust_viewer.sql (pre-launch security review follow-up)
--
-- Defense-in-depth: make guest_unlock_status honor the trusted `viewer_id` arg ONLY
-- on the service-role path, mirroring get_event_by_slug (0018, :165-166). Without this,
-- an anon caller could hit the helper directly via PostgREST as
--   guest_unlock_status(event_id, null, viewer_id => <some account uuid>)
-- and probe whether that account RSVP'd to an event (a low-severity RSVP-attendance
-- oracle — gated in practice only because get_event_by_slug already forces viewer_id
-- to null for non-service_role, and because the victim's auth.uid() is unguessable).
-- This closes the helper itself so it's safe regardless of who calls it. The trusted
-- SSR path (get_event_by_slug running as service_role) still passes a real viewer_id,
-- which is honored because auth.role() = 'service_role' inside that request. Token path,
-- account-via-own-JWT path, unlock set, and event-scoping are all unchanged. CREATE OR
-- REPLACE preserves the existing EXECUTE grants.

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
  -- `viewer_id` is TRUSTED input: honor it ONLY for the service-role SSR path. A direct
  -- anon/authenticated caller cannot supply another account's id to probe its RSVP.
  v_viewer  uuid := case when auth.role() = 'service_role' then viewer_id else null end;
  -- The effective account identity: the caller's own JWT (auth.uid()) when present, else
  -- the trusted viewer_id. On a direct guest call this is exactly auth.uid() (0006).
  v_account uuid := coalesce(auth.uid(), v_viewer);
begin
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

  if not found then
    unlocked := false;
  end if;
end;
$$;
