-- 0014_set_event_password.sql — Task 2.2a: host-only set/clear of an event's
-- view password, with the bcrypt hashing done SERVER-SIDE in the DB.
--
-- WHY THIS EXISTS. The create/edit event form exposes an optional password
-- (SCHEMA §2 view_password_hash, D7⑤). The plaintext must NEVER reach the client
-- store nor be persisted — only a bcrypt hash. A host updates their own event row
-- through the RLS path, but PostgREST can only send a literal value, so it cannot
-- compute crypt()/gen_salt() inline. This SECURITY DEFINER RPC is the one place
-- the hash is minted: it takes the plaintext, checks the caller owns the event,
-- and writes bcrypt(password) (or NULL to clear).
--
-- HOST-ONLY (D7③, same contract as finalize_date/promote_guest): the check is
-- `auth.uid() = events.host_id` inside the function, so it MUST be called in a
-- host auth context. A different host, or a no-auth caller (service_role has no
-- auth.uid()), is rejected with a raise — it can never set another host's
-- password. The verifier `verify_event_password` (0007) is unchanged.
--
-- bcrypt: crypt(pw, gen_salt('bf', 12)) — the same algorithm/cost the verifier
-- expects. search_path pinned empty; every cross-schema call is qualified.

create or replace function public.set_event_password(event_id uuid, password text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_host uuid;
begin
  -- Resolve the owner. Unknown event → nothing to act on (and no existence oracle
  -- beyond "not found").
  select e.host_id into v_host
  from public.events e
  where e.id = set_event_password.event_id;

  if v_host is null then
    raise exception 'event not found';
  end if;

  -- Host-only: the caller must be the owning host (D7③). No auth context (e.g.
  -- service_role) → auth.uid() is null → rejected.
  if auth.uid() is null or auth.uid() <> v_host then
    raise exception 'not authorized to set this event password';
  end if;

  -- Empty / whitespace-only plaintext means "clear the password" (gate open);
  -- otherwise store a fresh bcrypt hash. The plaintext is never persisted.
  update public.events e
  set view_password_hash = case
        when set_event_password.password is null
             or length(btrim(set_event_password.password)) = 0 then null
        else extensions.crypt(set_event_password.password, extensions.gen_salt('bf', 12))
      end
  where e.id = set_event_password.event_id;
end;
$$;

-- EXECUTE: only the owning host (authenticated) ever sets a password. Guests
-- never create/edit events, so anon gets nothing; service_role is intentionally
-- excluded so the host-only contract can't be sidestepped from a trusted path.
revoke all on function public.set_event_password(uuid, text) from public;
grant execute on function public.set_event_password(uuid, text) to authenticated;
