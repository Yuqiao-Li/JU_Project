-- 0008_submit_rsvp.sql — Task 1.5b [SECURITY]: the single guest WRITE path
-- `submit_rsvp` — token→user_id→new dedup (D1), advisory-locked capacity /
-- waitlist (D7①), write-side DB depth rate limiting (D14), returns token +
-- confirmed status (D15). TASKS.md labels this "(0005c)".
--
-- Named 0008_* (logical "0005c"): the Supabase CLI only applies files whose
-- version prefix is purely numeric, so the physical numbering runs one ahead of
-- the logical labels (1.1a=0001 … 1.5a=0007, 1.5b=0008). This sorts right after
-- 0007_get_event_by_slug.sql — see the 0002…0007 headers for the same note.
--
-- WHY THIS EXISTS (SCHEMA 安全模型 §2 单一写路径; D1/D7①/D14/D15; G1).
-- `anon` has NO direct privilege on guests/rsvps (0004/0005) — every guest RSVP
-- write therefore flows through THIS SECURITY DEFINER function, which runs as the
-- table-owning migration role (bypassing RLS) and self-validates every input. It
-- is the only way a guest row or an RSVP is ever created from the public side.
--
-- THE DEDUP CONTRACT (D1, pinned — SCHEMA §4 去重逻辑):
--   1. guest_token present AND matches a guest IN THIS EVENT  → update that guest.
--      (token is the credential; it is matched event-scoped, so event A's token is
--       worthless against event B — a forged / cross-event / unknown token simply
--       fails to match and falls through; we NEVER honour a client-chosen token for
--       a new row, the server mints a fresh one via the column default.)
--   2. else, caller is logged in AND already has a guest (user_id = auth.uid()) in
--      this event → update that guest (cross-device recognition, D1). auth.uid()
--      reflects the CALLER's JWT even inside SECURITY DEFINER.
--   3. else → create a brand-new guest with a fresh server-minted token.
--   `contact` NEVER participates in matching (D1): it is host-visible metadata, not
--   an identity key. A bare contact that happens to equal an existing guest's makes
--   an INDEPENDENT new row and returns the NEW token — it can never silently take
--   over an existing guest or leak that guest's token (TEST-SPEC §1.5b anti-hijack).
--   client never sends user_id; when the caller is authenticated we fill it
--   server-side from auth.uid(), and only when it is currently null (coalesce) so a
--   token-bearing update can never re-home a guest into a different account.
--
-- CAPACITY / WAITLIST (D7①): a per-event `pg_advisory_xact_lock(hashtext(id))`
-- serialises concurrent submits for the same event. INSIDE the lock we count the
-- `going` occupancy (1 + plus_ones, EXCLUDING the caller's own existing row so an
-- edit never double-counts) and, when a 'going' request would exceed `capacity`,
-- the new RSVP lands 'waitlisted' instead. The lock is held to commit, so two
-- racing submits can never both consume the last seat (no oversell). capacity NULL
-- = unlimited. maybe/not_going never consume capacity.
--
-- WRITE-SIDE DEPTH RATE LIMIT (D14/G7): before doing any work we atomically
-- upsert-and-increment a per-(event, identity) counter in `rate_limits` and raise
-- once it exceeds the cap in the current fixed 60-second window. This is the
-- BACKSTOP that still bites a caller who bypasses the Next/Upstash read limiter and
-- hits this RPC directly ("绕 Next 也拦"). Identity = the Next-injected real client
-- IP/fingerprint when present, else the guest_token (a returning guest), else a
-- per-event `anon` bucket. In the intended architecture legit guests reach this
-- through a Next route that injects their real IP, so each is isolated in its own
-- bucket; the shared `anon` bucket only collects callers who bypassed Next, for
-- whom a per-event cap is exactly right. The cap is deliberately generous so normal
-- bursts (a guest tweaking their RSVP; many distinct guests each on their own
-- IP/token) never trip it — only sustained abuse does.
--
-- RETURNS jsonb (D15): { event_id, guest_id, guest_token, status, plus_ones,
-- waitlisted }. `guest_token` is the token of the row we actually wrote (a fresh one
-- for a new guest, the existing one for an update) so the client can store it in
-- localStorage and edit later; `status` is the CONFIRMED outcome (may be
-- 'waitlisted' even though 'going' was requested). No third-tier field (other
-- guests' tokens/contact, the list) is ever returned.
--
-- search_path is pinned empty (everything schema-qualified, incl. auth.uid();
-- pg_catalog built-ins resolve implicitly) to harden the definer against
-- search_path hijacking — same posture as 0002/0006/0007. The guest_token column
-- default (gen_random_uuid, resolved at table-create time in 0002) supplies the
-- fresh token, so we never name a token source here.

create or replace function public.submit_rsvp(
  slug               text,
  display_name       text,
  status             text default 'going',
  guest_token        uuid default null,
  plus_ones          integer default 0,
  contact            text default null,
  client_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- DB depth rate limit (D14/G7): at most this many write attempts per
  -- (event, identity) per fixed 60-second window. Generous on purpose — a normal
  -- RSVP burst or many distinct guests (each in their own IP/token bucket) stay
  -- far under it; only sustained abuse of the shared bucket trips it. The
  -- independent TEST-SPEC §1.5b limiter test loops past this value.
  c_submit_limit constant integer := 50;

  v_event       public.events%rowtype;
  v_name        text;
  v_status      text;
  v_plus_ones   integer;
  v_guest_id    uuid;
  v_guest_token uuid;
  v_outcome     text;
  v_occupancy   integer;
  v_bucket      text;
  v_window      timestamptz;
  v_count       integer;
begin
  -- ── Input validation (the function is the trust boundary, CLAUDE.md rule 3) ──
  v_name := nullif(btrim(display_name), '');
  if v_name is null then
    raise exception 'display_name is required';
  end if;

  -- 'waitlisted' is a server outcome, never a client request; only these three are
  -- accepted as an intent.
  v_status := lower(btrim(coalesce(status, '')));
  if v_status not in ('going', 'maybe', 'not_going') then
    raise exception 'invalid RSVP status: %', status;
  end if;

  -- ── Resolve the event by slug. Unknown slug → error (no row to write to) ──────
  select * into v_event
  from public.events e
  where e.slug = submit_rsvp.slug;

  if not found then
    raise exception 'event not found';
  end if;

  -- The event must be accepting RSVPs: rsvp_enabled off ("只发信息不收回复") or a
  -- cancelled event rejects all guest RSVPs.
  if not v_event.rsvp_enabled then
    raise exception 'RSVP is disabled for this event';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'event is cancelled';
  end if;

  -- Clamp plus_ones to what the event allows (server-enforced, not just UI):
  -- 0 when plus-ones are off, else capped at max_plus_ones; never negative.
  v_plus_ones := least(
    greatest(coalesce(plus_ones, 0), 0),
    case when v_event.allow_plus_ones then v_event.max_plus_ones else 0 end
  );

  -- ── Write-side depth rate limit (D14) — before any real work, so abusers are
  -- stopped early. Identity prefers the Next-injected fingerprint, then the token,
  -- then a per-event anon bucket. Atomic upsert-and-increment on
  -- unique(bucket_key, window_start); count the attempt itself. ───────────────────
  v_bucket := 'submit:' || v_event.id::text || ':'
              || coalesce(nullif(client_fingerprint, ''), guest_token::text, 'anon');
  v_window := date_trunc('minute', now());

  insert into public.rate_limits (bucket_key, window_start, count)
  values (v_bucket, v_window, 1)
  on conflict (bucket_key, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;

  if v_count > c_submit_limit then
    raise exception 'submit_rsvp rate limit exceeded' using errcode = 'P0001';
  end if;

  -- ── Per-event serialization for the capacity decision (D7①). Held to commit, so
  -- concurrent submits cannot both take the last seat. ────────────────────────────
  perform pg_advisory_xact_lock(hashtext(v_event.id::text));

  -- ── Dedup (D1): token (event-scoped) → linked account → new guest ─────────────
  -- (1) token match in THIS event.
  if guest_token is not null then
    select g.id, g.guest_token into v_guest_id, v_guest_token
    from public.guests g
    where g.event_id = v_event.id
      and g.guest_token = submit_rsvp.guest_token;
  end if;

  -- (2) else, the caller's linked account already has a guest here.
  if v_guest_id is null and auth.uid() is not null then
    select g.id, g.guest_token into v_guest_id, v_guest_token
    from public.guests g
    where g.event_id = v_event.id
      and g.user_id = auth.uid();
  end if;

  if v_guest_id is not null then
    -- Update the matched guest's mutable fields. user_id is filled from auth.uid()
    -- ONLY when currently null (coalesce) — a token-bearing edit can never re-home
    -- the guest into a different account. contact is host-visible metadata only.
    update public.guests g
       set display_name = v_name,
           contact      = submit_rsvp.contact,
           user_id      = coalesce(g.user_id, auth.uid())
     where g.id = v_guest_id;
  else
    -- (3) brand-new guest: fresh server-minted token (column default), account link
    -- from auth.uid() (null for anon). contact carried as metadata, never matched.
    insert into public.guests (event_id, display_name, contact, user_id)
    values (v_event.id, v_name, submit_rsvp.contact, auth.uid())
    -- qualify guest_token: the column shares the function parameter's name, so an
    -- unqualified reference here is ambiguous (variable_conflict = error).
    returning guests.id, guests.guest_token into v_guest_id, v_guest_token;
  end if;

  -- ── Capacity / waitlist decision (D7①), inside the advisory lock ──────────────
  -- Occupancy = going headcount including plus-ones, EXCLUDING this guest's own row
  -- (so an edit doesn't double-count). A 'going' request that would exceed capacity
  -- lands 'waitlisted'; maybe/not_going pass through unchanged. capacity NULL =
  -- unlimited. Mirrors get_event_by_slug's occupancy formula.
  if v_status = 'going' and v_event.capacity is not null then
    select coalesce(sum(1 + r.plus_ones), 0) into v_occupancy
    from public.rsvps r
    where r.event_id = v_event.id
      and r.status = 'going'
      and r.guest_id <> v_guest_id;

    if v_occupancy + (1 + v_plus_ones) > v_event.capacity then
      v_outcome := 'waitlisted';
    else
      v_outcome := 'going';
    end if;
  else
    v_outcome := v_status;
  end if;

  -- ── Upsert the RSVP (unique(event_id, guest_id)). updated_at maintained by the
  -- rsvps BEFORE UPDATE trigger (0002); approval_status stays its 'approved'
  -- default (🟡 MVP). ─────────────────────────────────────────────────────────────
  insert into public.rsvps (event_id, guest_id, status, plus_ones)
  values (v_event.id, v_guest_id, v_outcome, v_plus_ones)
  on conflict (event_id, guest_id)
    do update set status    = excluded.status,
                  plus_ones = excluded.plus_ones;

  -- ── Confirmation (D15): own token + confirmed status. Never any third-tier
  -- field (other guests' tokens/contact, the list). ───────────────────────────────
  return jsonb_build_object(
    'event_id',    v_event.id,
    'guest_id',    v_guest_id,
    'guest_token', v_guest_token,
    'status',      v_outcome,
    'plus_ones',   v_plus_ones,
    'waitlisted',  (v_outcome = 'waitlisted')
  );
end;
$$;

-- EXECUTE: anon is the primary RSVP caller (browser); authenticated lets a
-- logged-in guest link their account (user_id); service_role for the trusted SSR /
-- server-action path that injects the real client IP into client_fingerprint.
-- PUBLIC's implicit default execute is replaced by these explicit grants.
revoke all on function
  public.submit_rsvp(text, text, text, uuid, integer, text, text) from public;
grant execute on function
  public.submit_rsvp(text, text, text, uuid, integer, text, text)
  to anon, authenticated, service_role;
