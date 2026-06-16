-- 0006_guest_unlock_status.sql — Task 1.5.0 [SECURITY]: the shared unlock gate
-- helper `guest_unlock_status` (TASKS.md labels this "(0005a)").
--
-- Named 0006_* (logical "0005a"): the Supabase CLI only applies files whose
-- version prefix is purely numeric, so the physical numbering runs one ahead of
-- the logical labels (1.1a=0001 … 1.4=0005, 1.5.0=0006). This sorts right after
-- 0005_anon_revoke.sql — see the 0002/0003/0004/0005 headers for the same note.
--
-- WHY THIS EXISTS (D5/D13, SCHEMA "guest_unlock_status" + RPC table; G4).
-- Every guest-facing RPC (get_event_by_slug / get_guest_list / add_comment, and
-- the unlock-gated branches of the others) needs the SAME yes/no answer: "does
-- the caller presenting THIS event + THIS guest_token (or, if logged in, their
-- account) have an RSVP that unlocks the second-tier view?" Centralising that one
-- decision here is a hard rule — 门禁逻辑只此一处 — so the gate can never drift
-- between call sites. The boundary check (护栏 6/G4) greps the three RPC bodies
-- and FAILS if any of them re-implements the gate instead of calling this helper.
--
-- THE GATE CONTRACT (SCHEMA, pinned):
--   * Unlock set = {going, maybe, waitlisted}. `not_going` does NOT unlock (a
--     decline must not reveal the address / list), and neither does "no RSVP".
--   * The guest_token is matched **scoped to event_id** — event A's token is
--     worthless against event B (cross-event replay yields no match).
--   * Account fallback (D1): a logged-in caller is also recognised when
--     guests.user_id = auth.uid(), so they unlock across devices without the
--     token. `auth.uid()` reflects the CALLER's JWT even inside SECURITY DEFINER
--     (it reads request.jwt.claims, a session GUC, not the function's role).
--   * `contact` is NEVER consulted — it is host-visible metadata, never identity
--     (D1). The matched guest_id is returned so add_comment can bind authorship
--     server-side without a second lookup.
--
-- RETURN SHAPE: exactly ONE record (OUT params → PostgREST single object, matching
-- the SCHEMA's `{guest_id, unlocked, status}`). On a miss the row is
-- (guest_id=null, unlocked=FALSE, status=null) — `unlocked` is ALWAYS a non-null
-- boolean, which is the whole point of the gate, so callers read `unlocked`
-- (NOT FOUND). TEST-SPEC §1.5 phrases every miss as "unlocked=false", i.e. a row,
-- not an empty set — hence the explicit false fallback rather than 0 rows.
--
-- SECURITY DEFINER is deliberate and safe. The helper must read guests/rsvps
-- regardless of the caller's RLS so the account-fallback branch works even when
-- the caller is an ordinary attendee of someone else's event (a non-host, who has
-- no RLS path to that guests row). Owned by the migration role (postgres, which
-- owns those tables), it bypasses RLS for the read. It leaks nothing: it only ever
-- reports the gate status of a row the caller already proves they own — by holding
-- that row's unguessable uuid guest_token, or by being its linked account. No
-- contact, no other guest, no list. search_path is pinned empty (everything
-- schema-qualified incl. auth.uid()) to harden the definer against search_path
-- hijacking, mirroring the other definer functions in 0002.

create or replace function public.guest_unlock_status(
  event_id uuid,
  token    uuid default null,
  out guest_id uuid,
  out unlocked boolean,
  out status   text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Match the guest by token (event-scoped) OR by linked account, then read the
  -- RSVP status. Token is the primary credential, so when both branches could
  -- match (token row and a different account-linked row) the token row wins —
  -- ORDER BY token-match-first + LIMIT 1 keeps the answer deterministic. When
  -- `token` is null only the account branch can match (g.guest_token = null is
  -- never true), so there is at most one row anyway.
  select g.id,
         (r.status in ('going', 'maybe', 'waitlisted')),
         r.status
    into guest_id, unlocked, status
  from public.guests g
  join public.rsvps  r on r.guest_id = g.id
  where g.event_id = guest_unlock_status.event_id
    and (
      g.guest_token = guest_unlock_status.token
      or (auth.uid() is not null and g.user_id = auth.uid())
    )
  order by (g.guest_token = guest_unlock_status.token) desc nulls last
  limit 1;

  -- No matching guest/RSVP (wrong token, cross-event token, no token + not logged
  -- in, or guest never RSVP'd): force the gate closed. guest_id/status stay null.
  if not found then
    unlocked := false;
  end if;
end;
$$;

-- EXECUTE: the three gate-using RPCs call this internally as the function owner,
-- but TEST-SPEC §1.5 also unit-tests the helper directly (anon presents a token;
-- an authenticated session exercises the account branch), so anon/authenticated
-- need EXECUTE. Direct callability is harmless (see header: reports only the
-- caller's own gate status for a credential they already hold). service_role for
-- the trusted SSR path. PUBLIC's implicit default execute is replaced by these
-- explicit grants for clarity.
revoke all on function public.guest_unlock_status(uuid, uuid) from public;
grant execute on function public.guest_unlock_status(uuid, uuid)
  to anon, authenticated, service_role;
