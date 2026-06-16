-- 0009_get_guest_list.sql — Task 1.5c [SECURITY]: the desensitized guest-list read
-- path `get_guest_list` (unlock-gated, Going/Maybe only, display_name/status/
-- plus_ones only). TASKS.md labels this "(0005d)".
--
-- Named 0009_* (logical "0005d"): the Supabase CLI only applies files whose
-- version prefix is purely numeric, so the physical numbering runs one ahead of
-- the logical labels (1.1a=0001 … 1.5a=0007, 1.5b=0008, 1.5c=0009). This sorts
-- right after 0008_submit_rsvp.sql — see the 0002…0008 headers for the same note.
--
-- WHY THIS EXISTS (SCHEMA 安全模型 §1 单一读路径; D5/D15; G1/G4).
-- `anon` has NO direct privilege on guests/rsvps (0004/0005) — the guest list is
-- second-tier (SCHEMA "字段边界" 第二类) and reaches a guest ONLY through this
-- SECURITY DEFINER function, which runs as the table-owning migration role
-- (bypassing RLS) and enforces, in ONE place, both the unlock gate and the
-- desensitization. The host's own full list (incl. contact) is a separate path —
-- the direct events.host_id ownership RLS read (dashboard, M1) — NOT this RPC.
--
-- THE CONTRACT (SCHEMA "get_guest_list" + TEST-SPEC §1.5c, pinned):
--   * Caller must be UNLOCKED — decided ONLY by the shared gate helper
--     public.guest_unlock_status(event_id, token) (G4). 护栏 6 greps THIS function
--     body for the `guest_unlock_status(` call and FAILS the task if the gate is
--     re-implemented instead of reused. The helper scopes the token to event_id,
--     so a forged / cross-event / absent token ⇒ unlocked=false ⇒ no list (this is
--     exactly the cross-event-scope rejection TEST-SPEC §1.5c requires).
--   * `hide_guest_list=true` ⇒ no list, for everyone on this guest read path.
--   * ONLY Going/Maybe are surfaced — NOT Can't-Go (not_going), and NOT Waitlisted
--     (the waitlist is the host's own single-column view, not the public list).
--   * Each entry exposes ONLY display_name / status / plus_ones. guest_id,
--     guest_token and contact are NEVER placed in the result (第三类, D15) — we
--     return a jsonb array so the omission is structural (the keys simply do not
--     exist), which is what TEST-SPEC §1.5c checks (no contact/guest_id/token key).
--   * `anonymize_guest_list` is 🟡 (rendering left blank, SCHEMA §2) — deliberately
--     NOT applied here; display_name is returned verbatim for the MVP.
--
-- NO private/service_role gate here (unlike get_event_by_slug's D3 gate): the
-- unlock gate is strictly stronger. An un-RSVP'd viewer of a private event is not
-- unlocked and gets []; a guest who legitimately RSVP'd (holding a real token, or
-- their linked account) IS unlocked and should see the list — gating on
-- service_role would wrongly hide it from that legitimate unlocked guest. The
-- SSR/service_role path simply forwards the guest's token and inherits the same
-- unlock decision.
--
-- RETURNS jsonb — always a jsonb ARRAY. Every non-list outcome (unknown slug,
-- hidden list, locked caller, nobody going/maybe) returns the SAME '[]'::jsonb, so
-- the result type is uniform AND the caller cannot distinguish "hidden" from
-- "locked" from "empty" (no oracle on list state). TEST-SPEC §1.5c phrases the
-- hidden/locked cases as "返回空/被拒" — an empty array satisfies "空".
--
-- search_path is pinned empty (everything schema-qualified; jsonb_agg/
-- jsonb_build_object/coalesce are pg_catalog built-ins that resolve implicitly) to
-- harden the definer against search_path hijacking — same posture as 0006/0007/0008.

create or replace function public.get_guest_list(
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
  v_event       public.events%rowtype;
  v_is_unlocked boolean;
  v_result      jsonb;
begin
  -- Resolve the event by slug. Unknown slug → empty list (no existence oracle).
  select * into v_event
  from public.events e
  where e.slug = get_guest_list.slug;

  if not found then
    return '[]'::jsonb;
  end if;

  -- Host hid the list: no list on the guest read path. (The host still sees the
  -- full roster via the direct host-ownership RLS read, not this RPC.)
  if v_event.hide_guest_list then
    return '[]'::jsonb;
  end if;

  -- Unlock gate (G4): decided ONLY by the shared helper — token scoped to THIS
  -- event, or the caller's linked account. Forged / cross-event / absent token ⇒
  -- unlocked=false ⇒ the list stays hidden.
  select coalesce(gu.unlocked, false) into v_is_unlocked
  from public.guest_unlock_status(v_event.id, guest_token) gu;

  if not v_is_unlocked then
    return '[]'::jsonb;
  end if;

  -- Desensitized list (D15): ONLY display_name/status/plus_ones, ONLY Going/Maybe
  -- (no Can't-Go, no Waitlisted). No guest_id/token/contact ever leaves this query.
  -- jsonb_agg over an empty set is NULL → coalesce to '[]' so the type stays array.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'display_name', g.display_name,
               'status',       r.status,
               'plus_ones',    r.plus_ones
             )
             order by r.created_at asc, g.id
           ),
           '[]'::jsonb
         )
    into v_result
  from public.rsvps r
  join public.guests g on g.id = r.guest_id
  where r.event_id = v_event.id
    and r.status in ('going', 'maybe');

  return v_result;
end;
$$;

-- EXECUTE: anon is the primary caller (a guest's browser presenting their token);
-- authenticated lets a logged-in guest unlock via their linked account; service_role
-- for the trusted SSR path that forwards the guest's token. PUBLIC's implicit
-- default execute is replaced by these explicit grants.
revoke all on function public.get_guest_list(text, uuid) from public;
grant execute on function public.get_guest_list(text, uuid)
  to anon, authenticated, service_role;
